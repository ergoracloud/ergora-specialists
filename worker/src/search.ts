// Retrieval: Workers AI query embedding -> Vectorize (semantic), with a D1 FTS5 keyword fallback.
import { EMBED_DIMS, EMBED_MODEL, EMBED_POOLING, LIMITS, QUERY_INSTRUCTION, type Env } from "./config";
import { gateResult, type PublicResult } from "./policy";

export class UpstreamError extends Error {
  constructor(public component: "workers-ai" | "vectorize" | "d1", cause: string) {
    super(`${component}: ${cause}`);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, component: UpstreamError["component"]): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError(component, "timeout")), ms);
  });
  return Promise.race([p, t]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// One result per source page (the same article can be stored under several verticals, with near-identical
// summaries); results arrive best first, so the first one wins.
export function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    const q = [...u.searchParams].filter(([k]) => !k.toLowerCase().startsWith("utm_")).map(([k, v]) => `${k}=${v}`).join("&");
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${q ? `?${q}` : ""}`;
  } catch {
    return url;
  }
}
function addUnique(seen: Set<string>, r: PublicResult): boolean {
  const key = sourceKey(r.source_url);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export function normaliseQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?!.,;:]+$/, "").slice(0, LIMITS.MAX_QUERY_CHARS);
}

export async function cacheKey(vertical: string | undefined, k: number, query: string): Promise<string> {
  const data = new TextEncoder().encode(`v2|${vertical ?? "*"}|${k}|${normaliseQuery(query)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function embedQuery(env: Env, query: string): Promise<number[]> {
  let out: { data?: number[][] };
  try {
    out = (await withTimeout(
      env.AI.run(EMBED_MODEL as Parameters<Ai["run"]>[0], {
        text: [QUERY_INSTRUCTION + query.slice(0, LIMITS.MAX_QUERY_CHARS)],
        pooling: EMBED_POOLING,
      } as never),
      LIMITS.UPSTREAM_TIMEOUT_MS,
      "workers-ai",
    )) as { data?: number[][] };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError("workers-ai", (e as Error)?.message || "run failed");
  }
  const v = out?.data?.[0];
  if (!Array.isArray(v) || v.length !== EMBED_DIMS) throw new UpstreamError("workers-ai", "bad embedding shape");
  return v;
}

export async function semanticSearch(env: Env, query: string, vertical: string | undefined, k: number): Promise<PublicResult[]> {
  const vector = await embedQuery(env, query);
  const opts: VectorizeQueryOptions = { topK: Math.min(k + 5, 20), returnMetadata: "all" };
  if (vertical) opts.filter = { vertical: { $eq: vertical } };
  let r: VectorizeMatches;
  try {
    r = await withTimeout(env.KB.query(vector, opts), LIMITS.UPSTREAM_TIMEOUT_MS, "vectorize");
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError("vectorize", (e as Error)?.message || "query failed");
  }
  const out: PublicResult[] = [];
  const seen = new Set<string>();
  for (const m of r.matches || []) {
    const g = gateResult(m.metadata as Record<string, unknown>, m.score ?? 0, vertical, true);
    if (g && addUnique(seen, g)) out.push(g);
    if (out.length >= k) break;
  }
  return out;
}

const STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from get got had has have how i if in into is it its me my " +
    "not of on or our should so than that the their them then there these they this to too us was we what when " +
    "where which who why will with would you your best way ways tips good").split(" "),
);

// Builds a safe FTS5 MATCH expression: only [a-z0-9] tokens, each quoted, OR'ed, scoped to title+summary.
export function ftsExpression(query: string, vertical: string | undefined): string | null {
  const seen = new Set<string>();
  for (const t of query.toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    if (seen.size >= 8) break;
  }
  if (!seen.size) return null;
  const terms = [...seen].map((t) => `"${t}"`).join(" OR ");
  const scoped = `{title summary} : (${terms})`;
  return vertical ? `vertical : "${vertical}" AND ${scoped}` : scoped;
}

export async function keywordSearch(
  env: Env, query: string, vertical: string | undefined, k: number,
): Promise<{ results: PublicResult[]; rowsRead: number }> {
  const expr = ftsExpression(query, vertical);
  if (!expr) return { results: [], rowsRead: 0 };
  let res: D1Result<Record<string, unknown>>;
  try {
    res = await withTimeout(
      env.KB_FTS.prepare(
        `SELECT d.vertical, d.title, d.summary, d.source_url
           FROM kb_fts JOIN kb_docs d ON d.rid = kb_fts.rowid
          WHERE kb_fts MATCH ?1
          ORDER BY bm25(kb_fts, 4.0, 1.0, 0.0)
          LIMIT ?2`,
      ).bind(expr, Math.min(k + 5, 20)).all(),
      LIMITS.UPSTREAM_TIMEOUT_MS,
      "d1",
    );
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError("d1", (e as Error)?.message || "query failed");
  }
  const results: PublicResult[] = [];
  const seen = new Set<string>();
  for (const row of res.results || []) {
    const g = gateResult(row, null, vertical, false);
    if (g && addUnique(seen, g)) results.push(g);
    if (results.length >= k) break;
  }
  return { results, rowsRead: Number(res.meta?.rows_read ?? 0) };
}
