// Core query, shared by POST /query and the MCP tools.
// Order (cheapest first): validate -> in-isolate "cap already hit" -> BURST edge limiter -> Gate.admit
// (global cap, network quota, email quota, cache, Vectorize budget) -> semantic search -> keyword fallback.
import { attributionUrl, LIMITS, num, VERTICALS, type Env } from "./config";
import { deliverAlerts, upstreamAlert } from "./alerts";
import { publicError, STATUS, type PublicCode, type PublicError } from "./errors";
import type { Gate } from "./gate";
import { utcDay } from "./gate";
import { startConfirmation } from "./leads";
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
  base: string;
}

// Per-isolate memo: once the service cap is hit today, refuse without touching the Durable Object.
let capHitDay = "";
export const _resetIsolateState = () => {
  capHitDay = "";
};

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

  const caller = identify(env, input.email, input.ip);
  if (env.BURST) {
    const { success } = await env.BURST.limit({ key: caller.emailKey || caller.netKey });
    if (!success) return fail(env, "RATE_LIMITED");
  }

  const gate = gateStub(env);
  const key = await cacheKey(vertical, k, q);
  const adm = await gate.admit({
    now,
    netKey: caller.netKey,
    netLimit: caller.netLimit,
    emailKey: caller.emailKey,
    emailLimit: caller.emailLimit,
    globalLimit: num(env, "GLOBAL_DAILY_LIMIT", 2500),
    alertPct: num(env, "ALERT_THRESHOLD_PCT", 80),
    cacheKey: key,
    vectorBudget: num(env, "VECTORIZE_MONTHLY_QUERY_BUDGET", 66000),
    d1RowsBudget: num(env, "D1_DAILY_ROWS_READ_BUDGET", 4_000_000),
  });
  if (adm.alerts.length) ctx.waitUntil(deliverAlerts(env, gate, adm.alerts, now));
  if (!adm.ok) {
    if (adm.reason === "global") {
      capHitDay = today;
      return fail(env, "SERVICE_DAILY_LIMIT");
    }
    return fail(env, "DAILY_LIMIT_REACHED", { limit: adm.limit, kind: adm.reason === "email" ? "email" : caller.kind });
  }
  if (caller.emailKey) ctx.waitUntil(startConfirmation(env, gate, caller.emailKey, vertical || "any", input.base, now));

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
