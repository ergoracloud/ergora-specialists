// Static configuration shared by every module. Runtime knobs live in wrangler.toml [vars].

export const SERVER_VERSION = "0.4.3";
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Embedding model. MUST match sync/kb_v2_sync.py (same model, same pooling, documents without the
// query instruction). Changing any of these means a full re-embed into a new index.
export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBED_DIMS = 384;
export const EMBED_POOLING = "cls";
// BGE v1.5 recommends this instruction for short queries against passages (queries only).
export const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

export const VERTICALS: Record<string, string> = {
  sales: "Sales",
  marketing_fundamentals: "Marketing",
  ads: "Paid Ads",
  content: "Content Marketing",
  ecom: "Ecommerce",
  entrepreneurship: "Entrepreneurship",
  business_strategy: "Business Strategy",
  community: "Community Building",
  creator: "Creator Economy",
  design: "Design and UX",
  developer: "Developer and Engineering",
  finance: "Finance",
  hr: "HR and People Ops",
  leadership_management: "Leadership and Management",
  legal: "Legal (business and IP)",
  local: "Local Marketing",
  pr: "PR and Communications",
};

// MCP tool name -> [vertical slug, short label, what it covers]. Tool names match mcp/index.js.
export const SPECIALISTS: Record<string, [string, string, string]> = {
  ergora_sales: ["sales", "Sales", "prospecting, outreach, pipeline, closing, sales ops"],
  ergora_marketing: ["marketing_fundamentals", "Marketing", "positioning, strategy, growth, analytics"],
  ergora_ads: ["ads", "Paid Ads", "Meta, Google and TikTok ads, creative, media buying, attribution"],
  ergora_content: ["content", "Content Marketing", "SEO, editorial, distribution, content strategy"],
  ergora_ecommerce: ["ecom", "Ecommerce", "Shopify, WooCommerce and DTC, conversion, retention, email and SMS"],
  ergora_entrepreneurship: ["entrepreneurship", "Entrepreneurship", "starting, validating, funding and scaling a business"],
  ergora_business_strategy: ["business_strategy", "Business Strategy", "competitive strategy, OKRs, planning, positioning"],
  ergora_community: ["community", "Community Building", "brand communities, engagement, moderation, events"],
  ergora_creator: ["creator", "Creator Economy", "audience growth, monetisation, personal brand"],
  ergora_design: ["design", "Design and UX", "product design, usability, brand, design systems"],
  ergora_developer: ["developer", "Developer", "software craft, DevOps, architecture"],
  ergora_finance: ["finance", "Finance", "SaaS metrics, cash flow, valuation, fundraising, CFO topics"],
  ergora_hr: ["hr", "HR and People Ops", "hiring, culture, performance, employment"],
  ergora_leadership: ["leadership_management", "Leadership", "managing teams, execution, feedback"],
  ergora_legal: ["legal", "Business Legal", "contracts, IP, compliance, startup law (not legal advice)"],
  ergora_local: ["local", "Local Marketing", "local SEO, small business marketing, community presence"],
  ergora_pr: ["pr", "PR and Communications", "media relations, crisis comms, brand reputation"],
};

export const LIMITS = {
  MAX_EMAIL: 254, // RFC 5321
  MAX_BODY: 32 * 1024, // any legitimate MCP or JSON request is a few KB
  MAX_BATCH: 5, // JSON-RPC batch cap (each tools/call costs a Gate call; the whole batch spends one minute token)
  MAX_QUERY_CHARS: 2000,
  MAX_TOP_K: 10,
  UPSTREAM_TIMEOUT_MS: 6000,
} as const;

export interface Env {
  AI: Ai;
  KB: VectorizeIndex;
  KB_FTS: D1Database;
  GATE_DO: DurableObjectNamespace<import("./gate").Gate>;
  /** service binding to the uptime-hub Worker (same account: workers.dev fetches between them are refused) */
  UPTIME_HUB?: Fetcher;
  GATE_NAME?: string; // Durable Object instance name (tests use one per case); default "gate"

  // vars
  DAILY_LIMIT?: string;
  ANON_LIMIT?: string;
  IP_DAILY_LIMIT?: string;
  NET_UNCONFIRMED_LIMIT?: string;
  MAX_EMAILS_PER_NET?: string;
  V6_48_LIMIT?: string;
  ASN_LIMIT?: string;
  POOLED_CIDRS?: string;
  POOL_ANON_LIMIT?: string;
  POOL_IP_DAILY_LIMIT?: string;
  POOL_UNCONFIRMED_LIMIT?: string;
  POOL_UNCONFIRMED_EMAIL_LIMIT?: string;
  GLOBAL_DAILY_LIMIT?: string;
  GLOBAL_RESERVE_PCT?: string;
  ALERT_THRESHOLD_PCT?: string;
  VECTORIZE_MONTHLY_QUERY_BUDGET?: string;
  D1_DAILY_ROWS_READ_BUDGET?: string;
  CACHE_TTL_SEC?: string;
  CONFIRM_DAILY_LIMIT?: string;
  CONFIRM_NET_DAILY_LIMIT?: string;
  HEALTH_TTL_SEC?: string;
  BURST_PER_MINUTE?: string;
  HEALTH_PER_MINUTE?: string;
  HEALTH_QUERY_TTL_SEC?: string;
  ATTRIBUTION_URL?: string;
  PUBLIC_BASE_URL?: string;
  UPTIME_HUB_URL?: string;
  LOOPS_CONFIRM_TEMPLATE_ID?: string;

  // secrets
  LOOPS_API_KEY?: string;
  UPTIME_HUB_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

export function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function attributionUrl(env: Env): string {
  return env.ATTRIBUTION_URL || "https://ergora.app";
}

// Public base URL of this gateway (e.g. a future custom domain). Falls back to the request origin,
// so nothing is hardcoded to workers.dev.
export function baseUrl(env: Env, request: Request): string {
  const configured = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(configured)) return configured;
  return new URL(request.url).origin;
}
