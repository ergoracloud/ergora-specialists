// Remote MCP server (Streamable HTTP, stateless JSON responses).
import { LIMITS, MCP_VERSIONS, num, SERVER_VERSION, SPECIALISTS, VERTICALS, type Env } from "./config";
import { runQuery, type QueryOutcome } from "./query";

const toolInput = {
  type: "object",
  properties: {
    query: { type: "string", description: "The question or topic to research (natural language)." },
    top_k: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "How many insights to return (1-10)." },
    email: {
      type: "string",
      description: "Optional. The user's email. Unlocks the free tier (30 queries a day instead of 5 anonymous). Ask the user once, then pass it on every call.",
    },
  },
  required: ["query"],
};
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function mcpTools() {
  return [
    ...Object.entries(SPECIALISTS).map(([name, [, label, covers]]) => ({
      name,
      title: `Ergora ${label} Specialist`,
      description: `Ask the Ergora ${label} specialist (${covers}). Returns summarised, cited insights from a curated knowledge base of practitioners, books and research.`,
      inputSchema: toolInput,
      annotations: { title: `Ergora ${label} Specialist`, ...annotations },
    })),
    {
      name: "ergora_ask",
      title: "Ask all Ergora Specialists",
      description: "Ask across all 17 Ergora specialists at once (cross-vertical). Use a specific ergora_<vertical> tool when you know the domain.",
      inputSchema: {
        ...toolInput,
        properties: { ...toolInput.properties, vertical: { type: "string", enum: Object.keys(VERTICALS), description: "Optional: restrict to one vertical slug." } },
      },
      annotations: { title: "Ask all Ergora Specialists", ...annotations },
    },
    {
      name: "ergora_list_specialists",
      title: "List Ergora Specialists",
      description: "List the 17 Ergora specialist verticals and what each covers.",
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "List Ergora Specialists", ...annotations },
    },
  ];
}

export function formatToolText(env: Env, r: QueryOutcome, vertical: string | undefined): string {
  if (r.status !== 200 || !("results" in r.body)) {
    const b = r.body as { error: string; upgrade?: string };
    return `${b.error}${b.upgrade ? `\n\n${b.upgrade}` : ""}`;
  }
  const { results, attribution, meta } = r.body;
  const label = vertical ? VERTICALS[vertical] : "cross-vertical";
  if (!results.length) return `No matching insights found in the ${label} knowledge base. Try rephrasing, or another specialist (ergora_list_specialists).`;
  const lines = results.map(
    (x, i) =>
      `${i + 1}. ${x.title || "(untitled)"}${vertical ? "" : ` [${x.vertical}]`}${x.score == null ? "" : `, relevance ${x.score}`}` +
      `\n   ${x.summary}` +
      `\n   Source: ${x.source_url}`,
  );
  const quota =
    meta.identity === "email"
      ? `${meta.remaining_today} free queries remaining today`
      : `${meta.remaining_today} anonymous queries remaining today. Pass the user's email in the \`email\` argument to unlock ${num(env, "DAILY_LIMIT", 30)} a day free`;
  const note = meta.mode === "keyword" ? "\n(Keyword search mode: semantic search is temporarily unavailable.)" : "";
  return `${lines.join("\n")}\n\n${attribution}\n(${quota})${note}`;
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

interface Scope {
  env: Env;
  ctx: ExecutionContext;
  ip: string;
  hdrEmail: string;
  base: string;
}

type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };

export async function handleRpc(raw: unknown, s: Scope): Promise<object | null> {
  const msg = raw as Msg;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request");
  const { id, method } = msg;
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  if (id === undefined || id === null) return null; // notification

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: typeof requested === "string" && MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ergora-specialists", version: SERVER_VERSION },
        instructions:
          "17 Ergora business specialists (sales, marketing, ads, content, ecommerce, entrepreneurship, strategy, community, creator, design, developer, finance, HR, leadership, legal, local, PR). " +
          "Use ergora_<vertical> when the domain is known, ergora_ask across all. Every answer is summarised and cited; follow the source URLs for the originals. " +
          `Free tier: ${num(s.env, "ANON_LIMIT", 5)} queries a day anonymous, ${num(s.env, "DAILY_LIMIT", 30)} a day with an email (pass it in the \`email\` argument).`,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: mcpTools() });
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      if (name === "ergora_list_specialists") {
        const text = Object.entries(SPECIALISTS)
          .map(([tool, [slug, label, covers]]) => `- ${tool} (${slug}): ${label}, ${covers}`)
          .join("\n");
        return rpcResult(id, { content: [{ type: "text", text }] });
      }
      let vertical: unknown;
      if (name === "ergora_ask") vertical = args.vertical || undefined;
      else if (Object.hasOwn(SPECIALISTS, name)) vertical = SPECIALISTS[name][0];
      else return rpcError(id, -32602, "Unknown tool");
      try {
        const r = await runQuery(s.env, s.ctx, {
          query: typeof args.query === "string" ? args.query : "",
          vertical,
          topK: args.top_k,
          email: s.hdrEmail || args.email,
          ip: s.ip,
          base: s.base,
        });
        const v = typeof vertical === "string" && Object.hasOwn(VERTICALS, vertical) ? vertical : undefined;
        return rpcResult(id, { content: [{ type: "text", text: formatToolText(s.env, r, v) }], isError: r.status !== 200 });
      } catch (e) {
        console.error("tools/call failed:", (e as Error)?.message);
        return rpcResult(id, { content: [{ type: "text", text: "The Ergora tool hit an internal error. Please try again." }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

export async function handleMcp(request: Request, scope: Omit<Scope, "ip" | "hdrEmail">, cors: Record<string, string>): Promise<Response> {
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors, ...extra } });
  if (request.method === "GET") return new Response("Method Not Allowed: this server uses stateless JSON responses (POST only)", { status: 405, headers: { allow: "POST", ...cors } });
  if (request.method === "DELETE") return new Response(null, { status: 200, headers: cors });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...cors } });
  if (parseInt(request.headers.get("content-length") || "0", 10) > LIMITS.MAX_BODY) return json(rpcError(null, -32600, "Request too large"), 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > LIMITS.MAX_BODY) return json(rpcError(null, -32600, "Request too large"), 413);
    body = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const s: Scope = {
    ...scope,
    ip: request.headers.get("cf-connecting-ip") || "",
    hdrEmail: request.headers.get("x-ergora-email") || "",
  };
  const msgs = Array.isArray(body) ? body : [body];
  if (msgs.length > LIMITS.MAX_BATCH) return json(rpcError(null, -32600, `Batch too large (max ${LIMITS.MAX_BATCH})`), 400);
  const out: object[] = [];
  for (const m of msgs) {
    const r = await handleRpc(m, s);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202, headers: cors });
  const pv = request.headers.get("mcp-protocol-version") || MCP_VERSIONS[0];
  return json(Array.isArray(body) ? out : out[0], 200, { "mcp-protocol-version": pv });
}
