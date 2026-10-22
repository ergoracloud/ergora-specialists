// Core query, shared by POST /query and the MCP tools.
// Order (cheapest first): validate -> BURST edge limiter (always keyed on the network, never on the email, so
// rotating emails does not reset it) -> per-isolate rejection memo (cap hit, network or email already refused, so
// repeat offenders never reach the Durable Object) -> Gate.admit (global cap and reserve, network, unconfirmed,
// /48 + ASN, distinct-email and email quotas, cache, Vectorize budget) -> semantic search -> keyword fallback.
import { attributionUrl, LIMITS, num, VERTICALS, type Env } from "./config";
import { deliverAlerts, upstreamAlert } from "./alerts";
import { publicError, STATUS, type PublicCode, type PublicError } from "./errors";
import type { Gate } from "./gate";
import { utcDay } from "./gate";
import { confirmationConfigured, startConfirmation } from "./leads";
import { identify, type Caller } from "./net";
import type { PublicResult } from "./policy";
import { cacheKey, keywordSearch, semanticSearch, UpstreamError } from "./search";

export type Mode = "semantic" | "keyword" | "cache";

export interface QueryOk {
  results: PublicResult[];
  attribution: string;
  meta: { vertical: string | null; count: number; remaining_today: number; identity: Caller["kind"]; mode: Mode };
}

export type QueryOutcome = { status: 200; body: QueryOk } | { status: number; body: PublicError };

export interface QueryInput {
  query: unknown;
  vertical?: unknown;
  topK?: unknown;
  email?: unknown;
  ip: string;
  /** request.cf.asn */
  asn?: number | null;
  /** explicit opt-in to the confirmation email */
  optIn?: boolean;
  base: string;
  /** the caller (MCP batch) already spent a BURST token for this HTTP request */
  burstChecked?: boolean;
}

// Per-isolate memos so refused callers do not reach the Durable Object again:
//  - capHitDay / openCapHitDay: the service cap (or the open, non-reserved share of it) is used up today
//  - refused: a network, /48, ASN or email key the Gate already refused, until the end of the UTC day
//    ("all", "anon", "email") or for a few minutes ("unconf": an email confirmed elsewhere may still pass)
//  - confirmedEmails: emails the Gate reported as confirmed (they skip the unconfirmed memos)
let capHitDay = "";
let openCapHitDay = "";
const refused = new Map<string, number>();
const confirmedEmails = new Set<string>();
const seenOnNet = new Set<string>(); // `${day}|${netKey}|${email}` admitted in this isolate (exempt from the new-email memo)
const MEMO_MAX = 5000;
const UNCONF_MEMO_MS = 10 * 60_000;
export const _resetIsolateState = () => {
  capHitDay = "";
  openCapHitDay = "";
  refused.clear();
  confirmedEmails.clear();
  seenOnNet.clear();
};
const endOfUtcDay = (now: number) => Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
function remember(key: string, until: number): void {
  if (refused.size >= MEMO_MAX) refused.clear();
  refused.set(key, until);
}
function isRefused(key: string, now: number): boolean {
  const until = refused.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  refused.delete(key);
  return false;
}

// Spends one BURST token for this caller's network. Shared by /query, MCP (once per HTTP request) and /health/deep.
export async function burstOk(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (e) {
    // Fail open: the limiter is a best-effort edge guard and the Gate still enforces the daily quotas. Log so a broken binding is visible.
    console.error("burst limiter error:", (e as Error)?.name, (e as Error)?.message);
    return true;
  }
}

export const gateStub = (env: Env): DurableObjectStub<Gate> => env.GATE_DO.get(env.GATE_DO.idFromName(env.GATE_NAME || "gate"));

const fail = (env: Env, code: PublicCode, extra?: { limit?: number; kind?: string }): QueryOutcome => ({
  status: STATUS[code],
  body: publicError(env, code, extra),
});

export async function runQuery(env: Env, ctx: ExecutionContext, input: QueryInput): Promise<QueryOutcome> {
  const { query } = input;
  if (typeof query !== "string" || !query.trim()) return fail(env, "BAD_REQUEST");
  let vertical: string | undefined;
  if (input.vertical != null && input.vertical !== "") {
    if (typeof input.vertical !== "string" || !Object.hasOwn(VERTICALS, input.vertical)) return fail(env, "UNKNOWN_VERTICAL");
    vertical = input.vertical;
  }
  const k = Math.min(Math.max(parseInt(String(input.topK ?? 5), 10) || 5, 1), LIMITS.MAX_TOP_K);
  const q = query.slice(0, LIMITS.MAX_QUERY_CHARS);
  const now = Date.now();
  const today = utcDay(now);
  if (capHitDay === today) return fail(env, "SERVICE_DAILY_LIMIT");

  const caller = identify(env, input.email, input.ip, input.asn);
  if (!input.burstChecked && !(await burstOk(env.BURST, caller.burstKey))) return fail(env, "RATE_LIMITED");

  // Refuse from the memo where the Gate would refuse anyway.
  const known = caller.emailKey ? confirmedEmails.has(caller.emailKey) : false;
  const netKeys = [caller.netKey, ...caller.secondary.map((s) => s.key)];
  const limitKind = caller.kind;
  if (isRefused(`all|${caller.netKey}`, now)) return fail(env, "DAILY_LIMIT_REACHED", { limit: caller.netLimit, kind: limitKind });
  if (!caller.emailKey && isRefused(`anon|${caller.netKey}`, now)) return fail(env, "DAILY_LIMIT_REACHED", { limit: caller.anonLimit, kind: limitKind });
  if (caller.emailKey && isRefused(`email|${caller.emailKey}`, now)) return fail(env, "DAILY_LIMIT_REACHED", { kind: "email" });
  if (!known && netKeys.some((k) => isRefused(`unconf|${k}`, now))) return fail(env, "DAILY_LIMIT_REACHED", { kind: caller.emailKey ? "unconfirmed" : limitKind });
  const seenKey = caller.emailKey ? `${today}|${caller.netKey}|${caller.emailKey}` : "";
  if (caller.emailKey && !known && !seenOnNet.has(seenKey) && isRefused(`newemail|${caller.netKey}`, now)) {
    return fail(env, "TOO_MANY_EMAILS", { limit: caller.maxEmailsPerNet });
  }
  if (!known && !caller.pooled && !caller.emailKey && openCapHitDay === today) return fail(env, "SERVICE_DAILY_LIMIT");

  const gate = gateStub(env);
  const key = await cacheKey(vertical, k, q);
  const adm = await gate.admit({
    now,
    netKey: caller.netKey,
    pooled: caller.pooled,
    anonLimit: caller.anonLimit,
    netLimit: caller.netLimit,
    unconfirmedNetLimit: caller.unconfirmedNetLimit,
    emailKey: caller.emailKey,
    emailLimit: caller.emailLimit,
    unconfirmedEmailLimit: caller.unconfirmedEmailLimit,
    maxEmailsPerNet: caller.maxEmailsPerNet,
    secondary: caller.secondary,
    globalLimit: num(env, "GLOBAL_DAILY_LIMIT", 2500),
    reservePct: num(env, "GLOBAL_RESERVE_PCT", 30),
    trackUse: confirmationConfigured(env),
    optIn: input.optIn === true,
    alertPct: num(env, "ALERT_THRESHOLD_PCT", 80),
    cacheKey: key,
    vectorBudget: num(env, "VECTORIZE_MONTHLY_QUERY_BUDGET", 66000),
    d1RowsBudget: num(env, "D1_DAILY_ROWS_READ_BUDGET", 4_000_000),
  });
  if (adm.alerts.length) ctx.waitUntil(deliverAlerts(env, gate, adm.alerts, now));
  if (caller.emailKey && adm.confirmed) {
    if (confirmedEmails.size >= MEMO_MAX) confirmedEmails.clear();
    confirmedEmails.add(caller.emailKey);
  }
  if (!adm.ok) {
    const eod = endOfUtcDay(now);
    switch (adm.reason) {
      case "global":
        capHitDay = today;
        return fail(env, "SERVICE_DAILY_LIMIT");
      case "open":
        if (!caller.emailKey && !caller.pooled) openCapHitDay = today;
        return fail(env, "SERVICE_DAILY_LIMIT");
      case "net":
        remember(`all|${adm.refusedKey}`, eod);
        return fail(env, "DAILY_LIMIT_REACHED", { limit: adm.limit, kind: limitKind });
      case "anon":
        remember(`anon|${adm.refusedKey}`, eod);
        return fail(env, "DAILY_LIMIT_REACHED", { limit: adm.limit, kind: limitKind });
      case "email":
        remember(`email|${adm.refusedKey}`, eod);
        return fail(env, "DAILY_LIMIT_REACHED", { limit: adm.limit, kind: "email" });
      case "emails":
        remember(`newemail|${adm.refusedKey}`, now + UNCONF_MEMO_MS);
        return fail(env, "TOO_MANY_EMAILS", { limit: adm.limit });
      default: // "unconfirmed" | "secondary"
        remember(`unconf|${adm.refusedKey}`, now + UNCONF_MEMO_MS);
        return fail(env, "DAILY_LIMIT_REACHED", { limit: adm.limit, kind: caller.emailKey ? "unconfirmed" : limitKind });
    }
  }
  if (seenKey) {
    if (seenOnNet.size >= MEMO_MAX) seenOnNet.clear();
    seenOnNet.add(seenKey);
  }
  if (caller.emailKey && caller.emailAddr && adm.confirmEligible) {
    ctx.waitUntil(
      startConfirmation(env, gate, { email: caller.emailKey, addr: caller.emailAddr, netKey: caller.burstKey }, vertical || "any", input.base, now),
    );
  }

  let results: PublicResult[] | undefined;
  let mode: Mode = "semantic";
  if (adm.cached) {
    try {
      results = JSON.parse(adm.cached) as PublicResult[];
      mode = "cache";
    } catch {
      results = undefined;
    }
  }
  if (!results && adm.vector) {
    try {
      results = await semanticSearch(env, q, vertical, k);
      mode = "semantic";
      ctx.waitUntil(
        gate.after({ now, cacheKey: key, value: JSON.stringify(results), cacheTtlSec: num(env, "CACHE_TTL_SEC", 86400), d1RowsBudget: 0 })
          .then(() => undefined),
      );
    } catch (e) {
      const comp = e instanceof UpstreamError ? e.component : "vectorize";
      console.error("semantic search failed:", (e as Error)?.message);
      ctx.waitUntil(upstreamAlert(env, gate, comp, adm.keyword ? "keyword fallback" : "no answer", now));
    }
  }
  if (!results && adm.keyword) {
    try {
      const kw = await keywordSearch(env, q, vertical, k);
      results = kw.results;
      mode = "keyword";
      const budget = num(env, "D1_DAILY_ROWS_READ_BUDGET", 4_000_000);
      ctx.waitUntil(
        gate.after({ now, d1RowsRead: kw.rowsRead, cacheTtlSec: 0, d1RowsBudget: budget })
          .then((alerts) => (alerts.length ? deliverAlerts(env, gate, alerts, now) : undefined)),
      );
    } catch (e) {
      console.error("keyword search failed:", (e as Error)?.message);
      ctx.waitUntil(upstreamAlert(env, gate, "d1", "no answer", now));
    }
  }
  if (!results) return fail(env, !adm.vector && !adm.keyword ? "SERVICE_DAILY_LIMIT" : "UPSTREAM_UNAVAILABLE");

  const label = vertical ? VERTICALS[vertical] : "cross-vertical";
  return {
    status: 200,
    body: {
      results,
      attribution: `Source: Ergora ${label} specialist knowledge base, ${attributionUrl(env)} (summarised insights; follow source_url for the original)`,
      meta: { vertical: vertical || null, count: results.length, remaining_today: Math.max(0, adm.limit - adm.used), identity: caller.kind, mode },
    },
  };
}
