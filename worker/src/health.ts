// GET /health       shallow: the Worker is up (touches nothing).
// GET /health/deep  real checks: Workers AI embed, Vectorize, D1. Bypasses quotas.
// The deep result is memoised in the Gate DO (HEALTH_TTL_SEC, default 300 s) so the KVM2 monitor and the
// uptime-hub watchdog probing every minute cost almost nothing. The real Vectorize query (which spends
// queried dimensions) runs at most every HEALTH_QUERY_TTL_SEC (default 1800 s); in between, describe()
// proves the index is reachable. Output holds only booleans, timings and counts, never error text.
import { EMBED_DIMS, num, SERVER_VERSION, type Env } from "./config";
import { upstreamAlert } from "./alerts";
import { gateStub } from "./query";
import { embedQuery } from "./search";

interface Check {
  ok: boolean;
  ms: number;
}
export interface DeepHealth {
  ok: boolean;
  service: string;
  version: string;
  checked_at: string;
  embed: Check & { dims?: number };
  vectorize: Check & { vectors?: number; queried?: boolean };
  keyword: Check;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (e) {
    console.error("health check failed:", (e as Error)?.message);
    return { ok: false, ms: Date.now() - t0 };
  }
}

export async function deepHealth(env: Env, ctx: ExecutionContext): Promise<DeepHealth> {
  const gate = gateStub(env);
  const now = Date.now();
  const memo = await gate.memoGet("health", now);
  if (memo) return JSON.parse(memo) as DeepHealth;

  const embed = await timed(() => embedQuery(env, "how do I price a SaaS product"));
  const runQuery = embed.ok && !(await gate.memoGet("health_query", now));
  const vec = await timed(async () => {
    if (runQuery && embed.value) {
      const r = await env.KB.query(embed.value, { topK: 1, returnMetadata: "none" });
      if (!r.matches?.length) throw new Error("empty index");
      return { queried: true, vectors: undefined as number | undefined };
    }
    const d = (await env.KB.describe()) as { vectorCount?: number; vectorsCount?: number };
    return { queried: false, vectors: d.vectorCount ?? d.vectorsCount };
  });
  const kw = await timed(async () => {
    const r = await env.KB_FTS.prepare("SELECT rid FROM kb_docs LIMIT 1").all();
    if (!r.results?.length) throw new Error("empty keyword index");
  });

  const out: DeepHealth = {
    ok: embed.ok && vec.ok && kw.ok,
    service: "ergora-specialists-gateway",
    version: SERVER_VERSION,
    checked_at: new Date(now).toISOString(),
    embed: { ok: embed.ok, ms: embed.ms, ...(embed.value ? { dims: EMBED_DIMS } : {}) },
    vectorize: { ok: vec.ok, ms: vec.ms, ...(vec.value ?? {}) },
    keyword: { ok: kw.ok, ms: kw.ms },
  };
  await gate.memoPut("health", JSON.stringify(out), now, num(env, "HEALTH_TTL_SEC", 300));
  if (runQuery && vec.ok) await gate.memoPut("health_query", "1", now, num(env, "HEALTH_QUERY_TTL_SEC", 1800));
  if (!embed.ok) ctx.waitUntil(upstreamAlert(env, gate, "workers-ai", "keyword fallback", now));
  if (!vec.ok) ctx.waitUntil(upstreamAlert(env, gate, "vectorize", "keyword fallback", now));
  if (!kw.ok) ctx.waitUntil(upstreamAlert(env, gate, "d1", "semantic only", now));
  return out;
}
