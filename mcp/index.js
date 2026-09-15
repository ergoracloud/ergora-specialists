#!/usr/bin/env node
// Ergora Specialists MCP — stdio server exposing 17 business-vertical specialists as tools.
// Each tool queries the hosted Ergora gateway (isolated KB store). Your keys never leave Ergora.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const GATEWAY = (process.env.ERGORA_GATEWAY_URL || "https://ergora-specialists-gateway.contact-c9e.workers.dev").replace(/\/$/, "");
const EMAIL = process.env.ERGORA_EMAIL || "";

// tool name -> vertical slug
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

const queryInput = {
  type: "object",
  properties: {
    query: { type: "string", description: "The question or topic to research (natural language)." },
    top_k: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "How many insights to return (1-10)." },
  },
  required: ["query"],
};

async function gatewayQuery(query, vertical, topK) {
  if (!EMAIL) {
    return { text: "Set ERGORA_EMAIL in this MCP server's env (your email — it's your free-tier access key, 30 queries/day). e.g. in claude_desktop_config.json: \"env\": {\"ERGORA_EMAIL\": \"you@company.com\"}" };
  }
  const res = await fetch(`${GATEWAY}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, vertical, email: EMAIL, topK }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const extra = data.upgrade ? `\n\n${data.upgrade}` : "";
    return { text: `Ergora gateway: ${data.error || res.status}${extra}` };
  }
  if (!data.results?.length) return { text: `No matching insights found for that query in the ${vertical || "cross-vertical"} knowledge base.` };
  const lines = data.results.map((r, i) =>
    `${i + 1}. ${r.title || "(untitled)"}${vertical ? "" : ` [${r.vertical}]`} — relevance ${r.score}` +
    (r.summary ? `\n   ${r.summary}` : "") +
    `\n   Source: ${r.source_url}`);
  return { text: `${lines.join("\n")}\n\n${data.attribution}\n(${data.meta.remaining_today} free queries remaining today)` };
}

const server = new Server({ name: "ergora-specialists", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...Object.entries(SPECIALISTS).map(([name, [, desc]]) => ({
      name,
      title: `Ergora ${desc.split(" — ")[0]} Specialist`,
      description: `Ask the Ergora ${desc}. Returns summarised, cited insights from a curated knowledge base of leading practitioners, books and research.`,
      inputSchema: queryInput,
      annotations: { title: `Ergora ${desc.split(" — ")[0]} Specialist`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    })),
    {
      name: "ergora_ask",
      title: "Ask all Ergora Specialists",
      description: "Ask across ALL 17 Ergora specialists at once (cross-vertical). Use a specific ergora_<vertical> tool when you know the domain.",
      inputSchema: { ...queryInput, properties: { ...queryInput.properties, vertical: { type: "string", enum: Object.values(SPECIALISTS).map(v => v[0]), description: "Optional: restrict to one vertical slug." } } },
      annotations: { title: "Ask all Ergora Specialists", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "ergora_list_specialists",
      title: "List Ergora Specialists",
      description: "List the 17 Ergora specialist verticals available and what each covers.",
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "List Ergora Specialists", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "ergora_list_specialists") {
      const text = Object.entries(SPECIALISTS).map(([tool, [slug, desc]]) => `• ${tool} (${slug}) — ${desc}`).join("\n");
      return { content: [{ type: "text", text }] };
    }
    if (name === "ergora_ask") {
      const r = await gatewayQuery(String(args.query || ""), args.vertical || undefined, args.top_k || 5);
      return { content: [{ type: "text", text: r.text }] };
    }
    if (SPECIALISTS[name]) {
      const r = await gatewayQuery(String(args.query || ""), SPECIALISTS[name][0], args.top_k || 5);
      return { content: [{ type: "text", text: r.text }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `Ergora tool error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
