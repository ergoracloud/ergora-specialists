// Per-network per-minute limiter (fixed 60 s windows aligned to the clock).
//
// Two layers:
//  1. This isolate-local counter: free, no I/O, stops a burst that lands on one isolate before it reaches the
//     Durable Object. It is not authoritative, because one network's requests can spread over several isolates.
//  2. The authoritative counter in the Gate DO (`admit` for queries, `healthPeek` for /health/deep). It rides on the
//     Gate call each of those paths already makes, so it adds no Durable Object requests (Free: 100k/day).
// When the Gate refuses, the key is blocked locally until the window ends, so a refused network stops reaching the
// DO for the rest of that minute.
//
// This replaces the Cloudflare `ratelimits` bindings (BURST, HEALTH_BURST), which were deployed but never returned
// success:false in live tests (95 /health/deep calls in about 2 minutes from one IP, all 200).
export const WINDOW_MS = 60_000;
const MAX_KEYS = 5000;

export const windowStart = (now: number) => Math.floor(now / WINDOW_MS) * WINDOW_MS;
/** seconds until the current window ends (1 to 60), for Retry-After */
export const retryAfterSec = (now: number) => Math.max(1, Math.ceil((windowStart(now) + WINDOW_MS - now) / 1000));

const local = new Map<string, { w: number; n: number }>();

export const _resetMinuteState = () => local.clear();

function prune(w: number): void {
  for (const [k, v] of local) if (v.w !== w) local.delete(k);
  if (local.size >= MAX_KEYS) local.clear();
}

/** Takes one slot for `key` in this isolate's current window. False once `limit` slots are used. */
export function localMinuteOk(key: string, limit: number, now: number): boolean {
  const w = windowStart(now);
  const e = local.get(key);
  if (!e || e.w !== w) {
    if (local.size >= MAX_KEYS) prune(w);
    if (limit < 1) return false;
    local.set(key, { w, n: 1 });
    return true;
  }
  if (e.n >= limit) return false;
  e.n += 1;
  return true;
}

/** The Gate refused this key for the current window: refuse locally until the window ends. */
export function blockLocal(key: string, limit: number, now: number): void {
  const w = windowStart(now);
  if (local.size >= MAX_KEYS) prune(w);
  local.set(key, { w, n: Math.max(limit, 1) });
}

/**
 * One minute token per HTTP request. A /query request makes one; an MCP request with a batch of tools/call shares one
 * across the batch, so the first Gate call checks the authoritative counter and the rest reuse the answer.
 */
export interface MinuteToken {
  state: "pending" | "spent" | "limited";
  key: string;
  limit: number;
  retryAfter?: number;
}
