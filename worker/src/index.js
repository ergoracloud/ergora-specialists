// Ergora Specialists — public KB gateway (Cloudflare Worker)
// Surfaces:
//   POST /mcp   — remote MCP server (Streamable HTTP, stateless JSON). Zero-install: Claude Code / Claude Desktop / Cursor point at the URL.
//   POST /query — plain JSON API used by the local stdio package (mcp/index.js).
// Query flow: identify caller (email → 30/day, else IP → 5/day) -> embed (Vertex gemini-embedding-001) -> Vectorize `ergora-kb`
// Reads ONLY the isolated Vectorize store. Never touches production Supabase.

const SERVER_VERSION = "0.2.1";
const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const VERTICALS = {
  sales: "Sales",
  marketing_fundamentals: "Marketing",
  ads: "Paid Ads",
  content: "Content Marketing",
  ecom: "Ecommerce",
  entrepreneurship: "Entrepreneurship",
  business_strategy: "Business Strategy",
  community: "Community Building",
  creator: "Creator Economy",
  design: "Design & UX",
  developer: "Developer / Engineering",
  finance: "Finance",
  hr: "HR & People Ops",
  leadership_management: "Leadership & Management",
  legal: "Legal (business / IP)",
  local: "Local Marketing",
  pr: "PR & Communications",
};

// MCP tool name -> [vertical slug, description]. Keep in sync with mcp/index.js.
const SPECIALISTS = {
  ergora_sales: ["sales", "Sales — prospecting, outreach, pipeline, closing, sales ops"],
  ergora_marketing: ["marketing_fundamentals", "Marketing fundamentals — positioning, strategy, growth, analytics"],
  ergora_ads: ["ads", "Paid ads — Meta/Google/TikTok, creative, media buying, attribution"],
  ergora_content: ["content", "Content marketing — SEO, editorial, distribution, content strategy"],
  ergora_ecommerce: ["ecom", "Ecommerce — Shopify/WooCommerce/DTC, conversion, retention, email/SMS"],
  ergora_entrepreneurship: ["entrepreneurship", "Entrepreneurship — starting, validating, funding, scaling a business"],
  ergora_business_strategy: ["business_strategy", "Business strategy — competitive strategy, OKRs, planning, positioning"],
  ergora_community: ["community", "Community building — brand communities, engagement, moderation, events"],
  ergora_creator: ["creator", "Creator economy — audience growth, monetisation, personal brand"],
  ergora_design: ["design", "Design & UX — product design, usability, brand, design systems"],
  ergora_developer: ["developer", "Developer / engineering — software craft, DevOps, architecture"],
  ergora_finance: ["finance", "Business finance — SaaS metrics, cash flow, valuation, fundraising, CFO"],
  ergora_hr: ["hr", "HR & people ops — hiring, culture, performance, employment"],
  ergora_leadership: ["leadership_management", "Leadership & management — managing teams, execution, feedback"],
  ergora_legal: ["legal", "Business legal — contracts, IP, compliance, startup law (not legal advice)"],
  ergora_local: ["local", "Local marketing — local SEO, small-business marketing, community presence"],
  ergora_pr: ["pr", "PR & communications — media relations, crisis comms, brand reputation"],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, x-ergora-email",
  "Access-Control-Expose-Headers": "mcp-protocol-version",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });

const upgradeLine = (env) =>
  `Ergora runs all ${Object.keys(VERTICALS).length} of these specialists as full AI agents with unlimited use — ${env.ATTRIBUTION_URL}`;

// ── GCP access token (service-account JWT signed with WebCrypto, cached per isolate) ──
let tokenCache = { token: null, exp: 0 };

function b64url(bytes) {
  let s = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function gcpToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const sa = JSON.parse(env.GCP_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  const assertion = `${header}.${payload}.${b64url(sig)}`;
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`gcp token ${res.status}`);
  const d = await res.json();
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return tokenCache.token;
}

// Query-side embedding — MUST match the corpus (gemini-embedding-001, 1024d, asymmetric query prefix)
async function embedQuery(env, query) {
  const token = await gcpToken(env);
  const url = `https://${env.GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT}/locations/${env.GCP_LOCATION}/publishers/google/models/gemini-embedding-001:embedContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: "task: question-answering | query: " + query.slice(0, 2000) }] },
      taskType: "QUESTION_ANSWERING",
      outputDimensionality: 1024,
    }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  const d = await res.json();
  return d.embedding.values;
}

// ── Lead capture (Loops) — fire-and-forget, never blocks the query ──
async function captureLead(env, email, vertical) {
  const key = `lead:${email}`;
  const existing = await env.GATE.get(key);
  if (existing) return;
  await env.GATE.put(key, JSON.stringify({ firstSeen: new Date().toISOString(), firstVertical: vertical || "any" }));
  if (!env.LOOPS_API_KEY) return;
  await fetch("https://app.loops.so/api/v1/contacts/create", {
    method: "POST",
    headers: { authorization: `Bearer ${env.LOOPS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email, source: "ergora-specialists-mcp", userGroup: "mcp-lead", firstVertical: vertical || "any" }),
  }).catch(() => {});
}

// ── Caller identity + rate limit (per UTC day). Email = free tier (DAILY_LIMIT); no email = anonymous per-IP (ANON_LIMIT). ──
function identify(email, ip) {
  if (email && EMAIL_RE.test(String(email).trim())) return { kind: "email", key: String(email).trim().toLowerCase() };
  return { kind: "ip", key: ip || "unknown" };
}
async function rateLimit(env, who) {
  const day = new Date().toISOString().slice(0, 10);
  const key = who.kind === "email" ? `rl:${who.key}:${day}` : `rl:ip:${who.key}:${day}`;
  const limit = parseInt((who.kind === "email" ? env.DAILY_LIMIT : env.ANON_LIMIT) || (who.kind === "email" ? "30" : "5"), 10);
  const used = parseInt((await env.GATE.get(key)) || "0", 10);
  if (used >= limit) return { ok: false, used, limit };
  await env.GATE.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return { ok: true, used: used + 1, limit };
}

// ── Core query — shared by /query and /mcp. Returns { status, body }. ──
async function runQuery(env, ctx, { query, vertical, topK, email, ip }) {
  if (!query || typeof query !== "string" || !query.trim()) return { status: 400, body: { error: "query required" } };
  if (vertical && !VERTICALS[vertical]) return { status: 400, body: { error: `unknown vertical '${vertical}'`, valid: Object.keys(VERTICALS) } };
  const k = Math.min(Math.max(parseInt(topK || 5, 10) || 5, 1), 10);
  const who = identify(email, ip);

  const rl = await rateLimit(env, who);
  if (!rl.ok) {
    const anonHint = who.kind === "ip"
      ? `Add an email to unlock ${env.DAILY_LIMIT || 30} free queries/day (X-Ergora-Email header, ERGORA_EMAIL, or the \`email\` tool argument). `
      : "";
    return { status: 429, body: { error: `daily limit reached (${rl.limit}/day ${who.kind === "email" ? "on the free tier" : "anonymous"})`, upgrade: anonHint + upgradeLine(env) } };
  }
  if (who.kind === "email") ctx.waitUntil(captureLead(env, who.key, vertical));

  let vector;
  try { vector = await embedQuery(env, query); } catch (e) { return { status: 502, body: { error: "embedding failed", detail: String(e.message) } }; }

  const opts = { topK: k, returnMetadata: "all" };
  if (vertical) opts.filter = { vertical: { $eq: vertical } };
  const r = await env.KB.query(vector, opts);
  const results = (r.matches || []).map(m => ({
    title: m.metadata?.title || "",
    summary: m.metadata?.summary || "",
    source_url: m.metadata?.source_url || "",
    vertical: m.metadata?.vertical || "",
    score: Math.round((m.score || 0) * 1000) / 1000,
  }));

  const label = vertical ? VERTICALS[vertical] : "cross-vertical";
  return {
    status: 200,
    body: {
      results,
      attribution: `Source: Ergora ${label} specialist knowledge base — ${env.ATTRIBUTION_URL} (summarised insights; follow source_url for the original)`,
      meta: { vertical: vertical || null, count: results.length, remaining_today: rl.limit - rl.used, identity: who.kind },
    },
  };
}

// ── Remote MCP (Streamable HTTP, stateless JSON responses) ──
const toolInput = {
  type: "object",
  properties: {
    query: { type: "string", description: "The question or topic to research (natural language)." },
    top_k: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "How many insights to return (1-10)." },
    email: { type: "string", description: "Optional. The user's email — unlocks the free tier (30 queries/day vs 5/day anonymous). Ask the user once, then pass it on every call." },
  },
  required: ["query"],
};
const toolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function mcpTools() {
  return [
    ...Object.entries(SPECIALISTS).map(([name, [, desc]]) => ({
      name,
      description: `Ask the Ergora ${desc}. Returns summarised, cited insights from a curated knowledge base of leading practitioners, books and research.`,
      inputSchema: toolInput,
      annotations: toolAnnotations,
    })),
    {
      name: "ergora_ask",
      description: "Ask across ALL 17 Ergora specialists at once (cross-vertical). Use a specific ergora_<vertical> tool when you know the domain.",
      inputSchema: { ...toolInput, properties: { ...toolInput.properties, vertical: { type: "string", enum: Object.keys(VERTICALS), description: "Optional: restrict to one vertical slug." } } },
      annotations: toolAnnotations,
    },
    {
      name: "ergora_list_specialists",
      description: "List the 17 Ergora specialist verticals available and what each covers.",
      inputSchema: { type: "object", properties: {} },
      annotations: toolAnnotations,
    },
  ];
}

function formatToolText(env, r, vertical) {
  if (r.status !== 200) return `${r.body.error}${r.body.detail ? ` (${r.body.detail})` : ""}${r.body.upgrade ? `\n\n${r.body.upgrade}` : ""}`;
  const { results, attribution, meta } = r.body;
  if (!results.length) return `No matching insights found in the ${vertical ? VERTICALS[vertical] : "cross-vertical"} knowledge base. Try rephrasing, or another specialist (ergora_list_specialists).`;
  const lines = results.map((x, i) =>
    `${i + 1}. ${x.title || "(untitled)"}${vertical ? "" : ` [${x.vertical}]`} — relevance ${x.score}` +
    (x.summary ? `\n   ${x.summary}` : "") +
    `\n   Source: ${x.source_url}`);
  const quota = meta.identity === "email"
    ? `${meta.remaining_today} free queries remaining today`
    : `${meta.remaining_today} anonymous queries remaining today — pass the user's email in the \`email\` argument to unlock ${env.DAILY_LIMIT || 30}/day free`;
  return `${lines.join("\n")}\n\n${attribution}\n(${quota})`;
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleRpc(msg, { env, ctx, ip, hdrEmail }) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request");
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // notification (initialized, cancelled, progress…) — nothing to send back

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ergora-specialists", version: SERVER_VERSION },
        instructions:
          `17 Ergora business specialists (sales, marketing, ads, content, ecommerce, entrepreneurship, strategy, community, creator, design, developer, finance, HR, leadership, legal, local, PR). ` +
          `Use ergora_<vertical> when the domain is known, ergora_ask across all. Every answer is summarised + cited — follow the source URLs for the originals. ` +
          `Free tier: ${env.ANON_LIMIT || 5} queries/day anonymous, ${env.DAILY_LIMIT || 30}/day with an email (pass it in the \`email\` argument).`,
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
      const name = params.name;
      const args = params.arguments || {};
      if (name === "ergora_list_specialists") {
        const text = Object.entries(SPECIALISTS).map(([tool, [slug, desc]]) => `• ${tool} (${slug}) — ${desc}`).join("\n");
        return rpcResult(id, { content: [{ type: "text", text }] });
      }
      let vertical;
      if (name === "ergora_ask") vertical = args.vertical || undefined;
      else if (SPECIALISTS[name]) vertical = SPECIALISTS[name][0];
      else return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const r = await runQuery(env, ctx, { query: String(args.query || ""), vertical, topK: args.top_k, email: hdrEmail || args.email, ip });
        return rpcResult(id, { content: [{ type: "text", text: formatToolText(env, r, vertical) }], isError: r.status !== 200 });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: `Ergora tool error: ${e.message}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(request, env, ctx) {
  if (request.method === "GET") return new Response("Method Not Allowed — this server uses stateless JSON responses (POST only)", { status: 405, headers: { allow: "POST", ...CORS } });
  if (request.method === "DELETE") return new Response(null, { status: 200, headers: CORS }); // no sessions to end
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...CORS } });

  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
  const scope = {
    env, ctx,
    ip: request.headers.get("cf-connecting-ip") || "",
    hdrEmail: request.headers.get("x-ergora-email") || "",
  };
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) { const r = await handleRpc(m, scope); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  const pv = request.headers.get("mcp-protocol-version") || MCP_VERSIONS[0];
  return json(Array.isArray(body) ? out : out[0], 200, { "mcp-protocol-version": pv });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/mcp") return handleMcp(request, env, ctx);

    if (url.pathname === "/" || url.pathname === "/health")
      return json({
        ok: true, service: "ergora-specialists-gateway", version: SERVER_VERSION, verticals: Object.keys(VERTICALS).length,
        mcp: `${url.origin}/mcp`,
        install: { claude_code: `claude mcp add --transport http ergora-specialists ${url.origin}/mcp --header "X-Ergora-Email: you@company.com"` },
      });

    if (url.pathname === "/verticals")
      return json({ verticals: Object.entries(VERTICALS).map(([slug, name]) => ({ slug, name })) });

    if (url.pathname === "/query" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
      const r = await runQuery(env, ctx, {
        query: body?.query, vertical: body?.vertical, topK: body?.topK,
        email: request.headers.get("x-ergora-email") || body?.email,
        ip: request.headers.get("cf-connecting-ip") || "",
      });
      return json(r.body, r.status);
    }

    return json({ error: "not found", routes: ["POST /mcp (MCP Streamable HTTP)", "GET /health", "GET /verticals", "POST /query {query, vertical?, email?, topK?}"] }, 404);
  },
};
