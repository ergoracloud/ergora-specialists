// Ergora Specialists: public KB gateway (Cloudflare Worker, built to run on the Workers Free plan).
// Surfaces:
//   POST /mcp          remote MCP server (Streamable HTTP, stateless JSON)
//   POST /query        JSON API used by the local stdio package (mcp/index.js)
//   GET  /health       shallow liveness
//   GET  /health/deep  Workers AI + Vectorize + D1 checks (memoised; for the uptime monitor)
//   GET  /verticals    list of vertical slugs
//   GET|POST /confirm  email double opt-in (Loops)
// Query path: Workers AI bge-small-en-v1.5 (384d) -> Vectorize `ergora-kb-v2`, D1 FTS5 `ergora-kb-fts` fallback.
// Reads ONLY these isolated Cloudflare stores. Never touches production Supabase, never calls Google.
import { baseUrl, LIMITS, SERVER_VERSION, VERTICALS, type Env } from "./config";
import { publicError, STATUS } from "./errors";
import { deepHealth } from "./health";
import { handleConfirm } from "./leads";
import { handleMcp } from "./mcp";
import { networkKey } from "./net";
import { burstOk, gateStub, runQuery } from "./query";

export { Gate } from "./gate";

// No CORS on purpose: every supported client (Claude, ChatGPT and other hosted connectors, Claude Code, the stdio
// package, MCP Inspector in its default proxy mode) calls from a server, not a browser page. Without
// Access-Control-Allow-Origin a random web page cannot spend visitors' quotas through their browsers.
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export const asnOf = (request: Request): number | null => {
  const asn = (request as Request & { cf?: { asn?: unknown } }).cf?.asn;
  return typeof asn === "number" ? asn : null;
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const base = baseUrl(env, request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST" } });

  switch (url.pathname) {
    case "/mcp":
      return handleMcp(request, { env, ctx, base, asn: asnOf(request) });

    case "/":
    case "/health":
      return json({
        ok: true,
        service: "ergora-specialists-gateway",
        version: SERVER_VERSION,
        verticals: Object.keys(VERTICALS).length,
        mcp: `${base}/mcp`,
        deep_health: `${base}/health/deep`,
        install: { claude_code: `claude mcp add --transport http ergora-specialists ${base}/mcp --header "X-Ergora-Email: you@company.com"` },
      });

    case "/health/deep": {
      // Memoised and single-flight in the Gate; the limiter stops one network from hammering it.
      // The KVM2 uptime monitor probes once a minute from one IP, far below this.
      const ip = request.headers.get("cf-connecting-ip") || "";
      if (!(await burstOk(env.HEALTH_BURST ?? env.BURST, `health|${networkKey(ip)}`))) {
        return json(publicError(env, "RATE_LIMITED"), STATUS.RATE_LIMITED, { "cache-control": "no-store", "retry-after": "60" });
      }
      const h = await deepHealth(env, ctx);
      return json(h, h.ok ? 200 : 503, { "cache-control": "no-store" });
    }

    case "/verticals":
      return json({ verticals: Object.entries(VERTICALS).map(([slug, name]) => ({ slug, name })) });

    case "/confirm":
      return handleConfirm(request, env, gateStub(env));

    case "/query": {
      if (request.method !== "POST") return json(publicError(env, "NOT_FOUND"), 404);
      if (parseInt(request.headers.get("content-length") || "0", 10) > LIMITS.MAX_BODY) return json(publicError(env, "REQUEST_TOO_LARGE"), 413);
      let body: Record<string, unknown>;
      try {
        const text = await request.text();
        if (text.length > LIMITS.MAX_BODY) return json(publicError(env, "REQUEST_TOO_LARGE"), 413);
        body = JSON.parse(text) ?? {};
      } catch {
        return json(publicError(env, "BAD_REQUEST"), 400);
      }
      const r = await runQuery(env, ctx, {
        query: body.query,
        vertical: body.vertical,
        topK: body.topK ?? body.top_k,
        email: request.headers.get("x-ergora-email") || body.email,
        ip: request.headers.get("cf-connecting-ip") || "",
        asn: asnOf(request),
        optIn: body.subscribe === true,
        base,
      });
      return json(r.body, r.status);
    }
  }
  return json({ ...publicError(env, "NOT_FOUND"), routes: ["POST /mcp", "GET /health", "GET /health/deep", "GET /verticals", "POST /query {query, vertical?, email?, topK?, subscribe?}"] }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      // Never leak internals (stack, upstream URLs, binding names) to callers.
      console.error("unhandled:", (e as Error)?.message);
      return json(publicError(env, "INTERNAL"), STATUS.INTERNAL);
    }
  },
} satisfies ExportedHandler<Env>;
