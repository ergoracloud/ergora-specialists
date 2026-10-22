// Gate: one SQLite-backed Durable Object that owns every counter, the response cache, alert flags and
// lead confirmations. A single instance is plenty for a 2,500/day service, and because a DO handles one
// call at a time the counters have no read-then-write race (the old KV counters did).
//
// Free plan budget (https://developers.cloudflare.com/durable-objects/platform/pricing/): 100,000 requests,
// 100,000 rows written and 5M rows read per day. An admitted query costs 2 DO calls and about 6 row writes
// (including the per-minute counter), so 2,500 queries/day use about 5,000 requests and 15,000 writes.
// Rejections write nothing. /health/deep costs 1 DO call and 1 row write per probe (its per-minute counter).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import { WINDOW_MS, windowStart } from "./minute";

export type AlertKind = "cap_warning" | "cap_reached" | "vector_budget" | "keyword_budget";

export interface AdmitInput {
  now: number;
  netKey: string;
  pooled: boolean;
  anonLimit: number;
  netLimit: number;
  unconfirmedNetLimit: number;
  emailKey?: string;
  emailLimit: number;
  unconfirmedEmailLimit: number;
  maxEmailsPerNet: number;
  secondary: Array<{ key: string; limit: number }>;
  globalLimit: number;
  /** % of the global cap kept for confirmed emails and pooled hosted clients */
  reservePct: number;
  /** count use per email (only when lead confirmation is configured) */
  trackUse: boolean;
  /** the caller explicitly asked for the confirmation email */
  optIn: boolean;
  alertPct: number;
  cacheKey: string;
  vectorBudget: number;
  d1RowsBudget: number;
  /** per-network per-minute limit, checked first; omitted when this HTTP request already passed it (MCP batch) */
  minute?: MinuteCheck;
}

export interface MinuteCheck {
  key: string;
  limit: number;
}

export type RejectReason = "minute" | "global" | "open" | "net" | "anon" | "unconfirmed" | "secondary" | "emails" | "email";

export interface AdmitResult {
  ok: boolean;
  reason?: RejectReason;
  /** the counter key that refused (for the per-isolate rejection memo) */
  refusedKey?: string;
  confirmed: boolean;
  /** a confirmation email may be offered to this address now (M1 rules) */
  confirmEligible: boolean;
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
export const USE_MIN_QUERIES = 3;
export const USE_MIN_DAYS = 2;
export const LEAD_RETENTION_DAYS = 60;
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
        CREATE TABLE IF NOT EXISTS lead_use (
          email TEXT PRIMARY KEY,
          n INTEGER NOT NULL,
          days INTEGER NOT NULL,
          last_day TEXT NOT NULL,
          last_seen INTEGER NOT NULL
        ) WITHOUT ROWID;
      `);
      const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(leads)").toArray().map((c) => c.name);
      if (!cols.includes("addr")) this.sql.exec("ALTER TABLE leads ADD COLUMN addr TEXT");
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
  // Per-network fixed-window minute counter. Full = this window is used up.
  private minuteKey(m: MinuteCheck, now: number): string {
    return `mi:${windowStart(now)}:${m.key}`;
  }
  private minuteFull(m: MinuteCheck, now: number): boolean {
    return this.count(this.minuteKey(m, now)) >= m.limit;
  }
  private minuteBump(m: MinuteCheck, now: number): void {
    // expires with the window; the daily alarm deletes it
    this.bump(this.minuteKey(m, now), 1, windowStart(now) + 2 * WINDOW_MS);
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
    const confirmed = i.emailKey ? this.leadState(i.emailKey)?.state === "confirmed" : false;
    const priority = i.pooled || confirmed;

    const reject = (reason: RejectReason, used: number, limit: number, refusedKey?: string): AdmitResult => ({
      ok: false, reason, refusedKey, confirmed, confirmEligible: false, used, limit, globalUsed, cached: null, vector: false, keyword: false, alerts,
    });

    if (i.minute && this.minuteFull(i.minute, i.now)) return reject("minute", i.minute.limit, i.minute.limit, i.minute.key);
    if (globalUsed >= i.globalLimit) {
      if (this.raise(`alert:cap_reached:${day}`, i.now, dayExp)) alerts.push("cap_reached");
      return reject("global", globalUsed, i.globalLimit);
    }
    // Open (non-priority) traffic may use only (100 - reservePct)% of the global cap.
    const openKey = `go:${day}`;
    const openLimit = Math.floor((i.globalLimit * (100 - Math.min(Math.max(i.reservePct, 0), 100))) / 100);
    if (!priority && this.count(openKey) >= openLimit) return reject("open", globalUsed, openLimit);

    const netKey = `n:${day}:${i.netKey}`;
    const netUsed = this.count(netKey);
    if (netUsed >= i.netLimit) return reject("net", netUsed, i.netLimit, i.netKey);

    const anonKey = `na:${day}:${i.netKey}`;
    if (!i.emailKey) {
      const a = this.count(anonKey);
      if (a >= i.anonLimit) return reject("anon", a, i.anonLimit, i.netKey);
    }
    const unconfKey = `nu:${day}:${i.netKey}`;
    if (!confirmed) {
      const u = this.count(unconfKey);
      if (u >= i.unconfirmedNetLimit) return reject("unconfirmed", u, i.unconfirmedNetLimit, i.netKey);
      for (const s of i.secondary) {
        const c = this.count(`s:${day}:${s.key}`);
        if (c >= s.limit) return reject("secondary", c, s.limit, s.key);
      }
    }
    // Distinct unconfirmed emails per network per day.
    let newEmailOnNet = false;
    const distinctKey = `dn:${day}:${i.netKey}`;
    const markKey = i.emailKey ? `de:${day}:${i.netKey}:${i.emailKey}` : "";
    if (i.emailKey && !confirmed && i.maxEmailsPerNet > 0 && this.count(markKey) === 0) {
      const d = this.count(distinctKey);
      if (d >= i.maxEmailsPerNet) return reject("emails", d, i.maxEmailsPerNet, i.netKey);
      newEmailOnNet = true;
    }
    let emailKey: string | undefined;
    const emailLimit = confirmed ? i.emailLimit : i.unconfirmedEmailLimit;
    if (i.emailKey) {
      emailKey = `e:${day}:${i.emailKey}`;
      const emailUsed = this.count(emailKey);
      if (emailUsed >= emailLimit) return reject("email", emailUsed, emailLimit, i.emailKey);
    }

    if (i.minute) this.minuteBump(i.minute, i.now);
    const g = this.bump(gKey, 1, dayExp);
    if (!priority) this.bump(openKey, 1, dayExp);
    this.bump(netKey, 1, dayExp);
    const a = i.emailKey ? 0 : this.bump(anonKey, 1, dayExp);
    if (!confirmed) {
      this.bump(unconfKey, 1, dayExp);
      for (const s of i.secondary) this.bump(`s:${day}:${s.key}`, 1, dayExp);
    }
    if (newEmailOnNet) {
      this.bump(markKey, 1, dayExp);
      this.bump(distinctKey, 1, dayExp);
    }
    const e = emailKey ? this.bump(emailKey, 1, dayExp) : 0;
    const warnAt = Math.max(1, Math.ceil((i.globalLimit * i.alertPct) / 100));
    if (g >= warnAt && g < i.globalLimit && this.raise(`alert:cap_warning:${day}`, i.now, dayExp)) alerts.push("cap_warning");
    if (g >= i.globalLimit && this.raise(`alert:cap_reached:${day}`, i.now, dayExp)) alerts.push("cap_reached");

    const used = emailKey ? e : a;
    const limit = emailKey ? emailLimit : i.anonLimit;
    const confirmEligible = Boolean(i.emailKey && i.trackUse && !confirmed && this.trackUse(i.emailKey, day, i.now, i.optIn));
    const base = { ok: true, confirmed, confirmEligible, used, limit, globalUsed: g, alerts };

    const hit = this.sql
      .exec<{ v: string }>("SELECT v FROM cache WHERE k = ? AND exp > ?", `q:${i.cacheKey}`, i.now)
      .toArray()[0];
    if (hit) return { ...base, cached: hit.v, vector: false, keyword: false };

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
    return { ...base, cached: null, vector, keyword };
  }

  private leadState(email: string): { state: string; confirm_sent_at: number | null; first_seen: number } | undefined {
    return this.sql
      .exec<{ state: string; confirm_sent_at: number | null; first_seen: number }>(
        "SELECT state, confirm_sent_at, first_seen FROM leads WHERE email = ?", email)
      .toArray()[0];
  }

  // A new confirmation may be claimed for this address (none sent in the last 30 days, not confirmed,
  // not found undeliverable in the last 30 days).
  private claimable(email: string, now: number): boolean {
    const row = this.leadState(email);
    if (!row) return true;
    if (row.state === "confirmed") return false;
    if (row.state === "pending" && row.confirm_sent_at && row.confirm_sent_at > now - 30 * DAY_MS) return false;
    if (row.state === "undeliverable" && row.first_seen > now - 30 * DAY_MS) return false;
    return true;
  }

  // Counts real use of an email; returns true once it qualifies for a confirmation email
  // (USE_MIN_QUERIES queries across USE_MIN_DAYS UTC days, or an explicit opt-in).
  private trackUse(email: string, day: string, now: number, optIn: boolean): boolean {
    this.sql.exec(
      `INSERT INTO lead_use (email, n, days, last_day, last_seen) VALUES (?, 1, 1, ?, ?)
       ON CONFLICT(email) DO UPDATE SET n = n + 1, days = days + (last_day <> excluded.last_day), last_day = excluded.last_day,
         last_seen = excluded.last_seen`,
      email, day, now,
    );
    const u = this.sql.exec<{ n: number; days: number }>("SELECT n, days FROM lead_use WHERE email = ?", email).toArray()[0];
    const qualifies = optIn || (!!u && u.n >= USE_MIN_QUERIES && u.days >= USE_MIN_DAYS);
    return qualifies && this.claimable(email, now);
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
  // One call per probe: the per-network minute check plus the memo read.
  healthPeek(m: MinuteCheck, now: number): { limited: boolean; memo: string | null } {
    if (this.minuteFull(m, now)) return { limited: true, memo: null };
    this.minuteBump(m, now);
    return { limited: false, memo: this.memoGet("health", now) };
  }
  memoGet(key: string, now: number): string | null {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM cache WHERE k = ? AND exp > ?", `m:${key}`, now).toArray()[0];
    return row ? row.v : null;
  }
  memoPut(key: string, value: string, now: number, ttlSec: number): void {
    this.sql.exec("INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)", `m:${key}`, value, now + ttlSec * 1000);
  }
  // One refresher at a time: true for the caller that should run the real checks. The claim expires on its own
  // after ttlSec in case that caller dies.
  beginRefresh(key: string, now: number, ttlSec: number): boolean {
    return this.raise(`refresh:${key}`, now, now + ttlSec * 1000);
  }
  endRefresh(key: string): void {
    this.sql.exec("DELETE FROM flags WHERE k = ?", `refresh:${key}`);
  }

  // ── lead confirmation (double opt-in before anything reaches Loops) ──
  // Claims one of the CONFIRM_DAILY_LIMIT daily slots (and one of netDailyLimit per network). Call it only after
  // the mail-domain check passed, so undeliverable addresses never use a slot.
  claimConfirmation(c: {
    email: string; addr: string; vertical: string; now: number; dailyLimit: number;
    netKey: string; netDailyLimit: number; tokenHash: string; tokenTtlSec: number;
  }): boolean {
    if (!this.claimable(c.email, c.now)) return false;
    const day = utcDay(c.now);
    const cKey = `c:${day}`;
    const cnKey = `cn:${day}:${c.netKey}`;
    if (this.count(cKey) >= c.dailyLimit || this.count(cnKey) >= c.netDailyLimit) return false;
    this.bump(cKey, 1, endOfDay(c.now));
    this.bump(cnKey, 1, endOfDay(c.now));
    this.sql.exec(
      `INSERT INTO leads (email, addr, state, first_vertical, first_seen, confirm_sent_at, token_hash, token_exp)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET state = 'pending', addr = excluded.addr, confirm_sent_at = excluded.confirm_sent_at,
         token_hash = excluded.token_hash, token_exp = excluded.token_exp`,
      c.email, c.addr, c.vertical, c.now, c.now, c.tokenHash, c.now + c.tokenTtlSec * 1000,
    );
    return true;
  }
  // The confirmation email could not be sent: forget the claim and give the slots back so a later query can retry.
  releaseClaim(email: string, tokenHash: string, netKey: string, now: number): void {
    const gone = this.sql
      .exec("DELETE FROM leads WHERE email = ? AND token_hash = ? AND state = 'pending' RETURNING email", email, tokenHash)
      .toArray().length;
    if (!gone) return;
    const day = utcDay(now);
    this.sql.exec("UPDATE counters SET n = MAX(0, n - 1) WHERE k = ? OR k = ?", `c:${day}`, `cn:${day}:${netKey}`);
  }
  // The address has no mail domain: remember that for 30 days without using a confirmation slot.
  markUndeliverable(email: string, now: number): void {
    this.sql.exec(
      `INSERT INTO leads (email, state, first_seen) VALUES (?, 'undeliverable', ?)
       ON CONFLICT(email) DO UPDATE SET state = 'undeliverable', first_seen = excluded.first_seen, token_hash = NULL, token_exp = NULL
       WHERE leads.state <> 'confirmed'`,
      email, now,
    );
  }
  // Single use: the token is cleared on success.
  confirm(tokenHash: string, now: number): { email: string; addr: string; firstVertical: string } | null {
    const row = this.sql
      .exec<{ email: string; addr: string | null; first_vertical: string | null }>(
        "SELECT email, addr, first_vertical FROM leads WHERE token_hash = ? AND token_exp > ? AND state = 'pending'", tokenHash, now)
      .toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE leads SET state = 'confirmed', confirmed_at = ?, token_hash = NULL, token_exp = NULL WHERE email = ?", now, row.email);
    return { email: row.email, addr: row.addr || row.email, firstVertical: row.first_vertical || "any" };
  }
  // A failed Loops call puts the lead back so the same link works again.
  unconfirm(email: string, tokenHash: string, now: number): void {
    this.sql.exec(
      "UPDATE leads SET state = 'pending', confirmed_at = NULL, token_hash = ?, token_exp = ? WHERE email = ?",
      tokenHash, now + 3_600_000, email,
    );
  }

  // Daily cleanup of expired counters, cache entries and flags, plus lead rows that never got confirmed
  // (pending or undeliverable) and per-email use counts once they are LEAD_RETENTION_DAYS old.
  async alarm(): Promise<void> {
    const now = Date.now();
    const cutoff = now - LEAD_RETENTION_DAYS * DAY_MS;
    this.sql.exec("DELETE FROM leads WHERE state <> 'confirmed' AND MAX(first_seen, COALESCE(confirm_sent_at, 0)) < ?", cutoff);
    this.sql.exec("DELETE FROM lead_use WHERE last_seen < ?", cutoff);
    this.sql.exec("DELETE FROM counters WHERE exp < ?", now);
    this.sql.exec("DELETE FROM cache WHERE exp < ?", now);
    this.sql.exec("DELETE FROM flags WHERE exp < ?", now);
    await this.ctx.storage.setAlarm(endOfDay(now));
  }
}
