// Gate: one SQLite-backed Durable Object that owns every counter, the response cache, alert flags and
// lead confirmations. A single instance is plenty for a 2,500/day service, and because a DO handles one
// call at a time the counters have no read-then-write race (the old KV counters did).
//
// Free plan budget (https://developers.cloudflare.com/durable-objects/platform/pricing/): 100,000 requests,
// 100,000 rows written and 5M rows read per day. An admitted query costs 2 DO calls and about 5 row writes,
// so 2,500 queries/day use about 5,000 requests and 12,500 writes. Rejections write nothing.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";

export type AlertKind = "cap_warning" | "cap_reached" | "vector_budget" | "keyword_budget";

export interface AdmitInput {
  now: number;
  netKey: string;
  netLimit: number;
  emailKey?: string;
  emailLimit: number;
  globalLimit: number;
  alertPct: number;
  cacheKey: string;
  vectorBudget: number;
  d1RowsBudget: number;
}

export interface AdmitResult {
  ok: boolean;
  reason?: "global" | "net" | "email";
  used: number;
  limit: number;
  globalUsed: number;
  cached: string | null;
  vector: boolean;
  keyword: boolean;
  alerts: AlertKind[];
}

export interface AfterInput {
  now: number;
  cacheKey?: string;
  value?: string;
  cacheTtlSec: number;
  d1RowsRead?: number;
  d1RowsBudget: number;
}

const DAY_MS = 86_400_000;
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const utcMonth = (now: number) => new Date(now).toISOString().slice(0, 7);
const endOfDay = (now: number) => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS + 2 * 3_600_000;
const endOfMonth = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + 2 * 3_600_000;
};

export class Gate extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS flags (k TEXT PRIMARY KEY, at INTEGER NOT NULL, exp INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS leads (
          email TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          first_vertical TEXT,
          first_seen INTEGER NOT NULL,
          confirm_sent_at INTEGER,
          token_hash TEXT,
          token_exp INTEGER,
          confirmed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS leads_token ON leads(token_hash);
      `);
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(endOfDay(Date.now()));
    });
  }

  // ── small helpers ──
  private count(k: string): number {
    const row = this.sql.exec<{ n: number }>("SELECT n FROM counters WHERE k = ?", k).toArray()[0];
    return row ? row.n : 0;
  }
  private bump(k: string, by: number, exp: number): number {
    this.sql.exec(
      "INSERT INTO counters (k, n, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n",
      k, by, exp,
    );
    return this.count(k);
  }
  // Returns true the first time a flag is raised inside its lifetime.
  private raise(k: string, now: number, exp: number): boolean {
    const hit = this.sql.exec("SELECT 1 FROM flags WHERE k = ? AND exp > ?", k, now).toArray().length > 0;
    if (hit) return false;
    this.sql.exec("INSERT OR REPLACE INTO flags (k, at, exp) VALUES (?, ?, ?)", k, now, exp);
    return true;
  }

  // ── quota + cache + budget decision for one query, atomically ──
  admit(i: AdmitInput): AdmitResult {
    const day = utcDay(i.now);
    const month = utcMonth(i.now);
    const dayExp = endOfDay(i.now);
    const alerts: AlertKind[] = [];
    const gKey = `g:${day}`;
    const globalUsed = this.count(gKey);

    const reject = (reason: AdmitResult["reason"], used: number, limit: number): AdmitResult => ({
      ok: false, reason, used, limit, globalUsed, cached: null, vector: false, keyword: false, alerts,
    });

    if (globalUsed >= i.globalLimit) {
      if (this.raise(`alert:cap_reached:${day}`, i.now, dayExp)) alerts.push("cap_reached");
      return reject("global", globalUsed, i.globalLimit);
    }
    const netKey = `n:${day}:${i.netKey}`;
    const netUsed = this.count(netKey);
    if (netUsed >= i.netLimit) return reject("net", netUsed, i.netLimit);
    let emailKey: string | undefined;
    let emailUsed = 0;
    if (i.emailKey) {
      emailKey = `e:${day}:${i.emailKey}`;
      emailUsed = this.count(emailKey);
      if (emailUsed >= i.emailLimit) return reject("email", emailUsed, i.emailLimit);
    }

    const g = this.bump(gKey, 1, dayExp);
    const n = this.bump(netKey, 1, dayExp);
    const e = emailKey ? this.bump(emailKey, 1, dayExp) : 0;
    const warnAt = Math.max(1, Math.ceil((i.globalLimit * i.alertPct) / 100));
    if (g >= warnAt && g < i.globalLimit && this.raise(`alert:cap_warning:${day}`, i.now, dayExp)) alerts.push("cap_warning");
    if (g >= i.globalLimit && this.raise(`alert:cap_reached:${day}`, i.now, dayExp)) alerts.push("cap_reached");

    const used = emailKey ? e : n;
    const limit = emailKey ? i.emailLimit : i.netLimit;

    const hit = this.sql
      .exec<{ v: string }>("SELECT v FROM cache WHERE k = ? AND exp > ?", `q:${i.cacheKey}`, i.now)
      .toArray()[0];
    if (hit) return { ok: true, used, limit, globalUsed: g, cached: hit.v, vector: false, keyword: false, alerts };

    // Reserve a Vectorize query against the monthly queried-dimensions budget.
    const vKey = `v:${month}`;
    let vector = false;
    if (this.count(vKey) < i.vectorBudget) {
      this.bump(vKey, 1, endOfMonth(i.now));
      vector = true;
    } else if (this.raise(`alert:vector_budget:${month}`, i.now, endOfMonth(i.now))) {
      alerts.push("vector_budget");
    }
    const keyword = this.count(`d1r:${day}`) < i.d1RowsBudget;
    return { ok: true, used, limit, globalUsed: g, cached: null, vector, keyword, alerts };
  }

  // Store the answer for repeats, and account D1 rows read by the keyword fallback.
  after(i: AfterInput): AlertKind[] {
    const alerts: AlertKind[] = [];
    if (i.cacheKey && i.value) {
      this.sql.exec(
        "INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)",
        `q:${i.cacheKey}`, i.value, i.now + i.cacheTtlSec * 1000,
      );
    }
    if (i.d1RowsRead && i.d1RowsRead > 0) {
      const day = utcDay(i.now);
      const total = this.bump(`d1r:${day}`, Math.ceil(i.d1RowsRead), endOfDay(i.now));
      if (total >= i.d1RowsBudget && this.raise(`alert:keyword_budget:${day}`, i.now, endOfDay(i.now))) alerts.push("keyword_budget");
    }
    return alerts;
  }

  // Generic once-per-window flag (upstream failure alerts and so on).
  flag(key: string, now: number, windowSec: number): boolean {
    return this.raise(`flag:${key}`, now, now + windowSec * 1000);
  }
  // Lets the caller re-arm a flag when delivering the alert failed.
  unflag(key: string): void {
    this.sql.exec("DELETE FROM flags WHERE k = ? OR k = ?", key, `flag:${key}`);
  }
  alertFlagKey(kind: AlertKind, now: number): string {
    return kind === "vector_budget" ? `alert:${kind}:${utcMonth(now)}` : `alert:${kind}:${utcDay(now)}`;
  }

  // ── memo for /health/deep so frequent probes cost almost nothing ──
  memoGet(key: string, now: number): string | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM cache WHERE k = ? AND exp > ?", `m:${key}`, now).toArray()[0];
    return row ? row.v : null;
  }
  memoPut(key: string, value: string, now: number, ttlSec: number): void {
    this.sql.exec("INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)", `m:${key}`, value, now + ttlSec * 1000);
  }

  // ── lead confirmation (double opt-in before anything reaches Loops) ──
  claimConfirmation(email: string, vertical: string, now: number, dailyLimit: number, tokenHash: string, tokenTtlSec: number): boolean {
    const row = this.sql
      .exec<{ state: string; confirm_sent_at: number | null; first_seen: number }>(
        "SELECT state, confirm_sent_at, first_seen FROM leads WHERE email = ?", email)
      .toArray()[0];
    const thirtyDays = 30 * DAY_MS;
    if (row) {
      if (row.state === "confirmed") return false;
      if (row.state === "pending" && row.confirm_sent_at && row.confirm_sent_at > now - thirtyDays) return false;
      if (row.state === "undeliverable" && row.first_seen > now - thirtyDays) return false;
    }
    const cKey = `c:${utcDay(now)}`;
    if (this.count(cKey) >= dailyLimit) return false;
    this.bump(cKey, 1, endOfDay(now));
    this.sql.exec(
      `INSERT INTO leads (email, state, first_vertical, first_seen, confirm_sent_at, token_hash, token_exp)
       VALUES (?, 'pending', ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET state = 'pending', confirm_sent_at = excluded.confirm_sent_at,
         token_hash = excluded.token_hash, token_exp = excluded.token_exp`,
      email, vertical, now, now, tokenHash, now + tokenTtlSec * 1000,
    );
    return true;
  }
  // The confirmation email could not be sent: forget the claim so a later query can retry.
  releaseClaim(email: string, tokenHash: string): void {
    this.sql.exec("DELETE FROM leads WHERE email = ? AND token_hash = ? AND state = 'pending'", email, tokenHash);
  }
  markUndeliverable(email: string): void {
    this.sql.exec("UPDATE leads SET state = 'undeliverable', token_hash = NULL WHERE email = ? AND state = 'pending'", email);
  }
  // Single use: the token is cleared on success.
  confirm(tokenHash: string, now: number): { email: string; firstVertical: string } | null {
    const row = this.sql
      .exec<{ email: string; first_vertical: string | null }>(
        "SELECT email, first_vertical FROM leads WHERE token_hash = ? AND token_exp > ? AND state = 'pending'", tokenHash, now)
      .toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE leads SET state = 'confirmed', confirmed_at = ?, token_hash = NULL, token_exp = NULL WHERE email = ?", now, row.email);
    return { email: row.email, firstVertical: row.first_vertical || "any" };
  }
  // A failed Loops call puts the lead back so the same link works again.
  unconfirm(email: string, tokenHash: string, now: number): void {
    this.sql.exec(
      "UPDATE leads SET state = 'pending', confirmed_at = NULL, token_hash = ?, token_exp = ? WHERE email = ?",
      tokenHash, now + 3_600_000, email,
    );
  }

  // Daily cleanup of expired counters, cache entries and flags.
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec("DELETE FROM counters WHERE exp < ?", now);
    this.sql.exec("DELETE FROM cache WHERE exp < ?", now);
    this.sql.exec("DELETE FROM flags WHERE exp < ?", now);
    await this.ctx.storage.setAlarm(endOfDay(now));
  }
}
