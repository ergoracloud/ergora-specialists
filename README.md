# Ergora Specialists — MCP

17 business-vertical knowledge specialists — Sales, Marketing, Paid Ads, Content, Ecommerce, Entrepreneurship, Business Strategy, Community, Creator, Design & UX, Developer, Finance, HR, Leadership, Legal, Local Marketing, PR — as tools for Claude Desktop, Claude Code, Cursor and any MCP client.

Each tool returns summarised, **cited** insights from a curated knowledge base of leading practitioners, best-selling books and academic/regulatory sources. Free tier: 5 queries/day anonymous, 30/day with an email.

> Ergora runs all 17 of these as full AI specialist agents with unlimited use → https://ergora.app

## Install — remote server (nothing to download)

Server URL: **`https://ergora-specialists-gateway.contact-c9e.workers.dev/mcp`** (MCP Streamable HTTP, no auth)

**Claude Code**
```bash
claude mcp add --transport http ergora-specialists https://ergora-specialists-gateway.contact-c9e.workers.dev/mcp --header "X-Ergora-Email: you@company.com"
```

**Claude Desktop / claude.ai** — Settings → Connectors → *Add custom connector* → paste the server URL. There is no login step; when Claude asks, give it your email to unlock 30 queries/day (it passes it in the tool's `email` argument).

**Cursor** — `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "ergora-specialists": {
      "url": "https://ergora-specialists-gateway.contact-c9e.workers.dev/mcp",
      "headers": { "X-Ergora-Email": "you@company.com" }
    }
  }
}
```

**Any other MCP client** — point it at the URL with the Streamable HTTP transport. The server is stateless (POST-only, JSON responses). The optional `X-Ergora-Email` header identifies you for the 30/day free tier.

## Install — local stdio server (from source)

Needs Node 18+.
```bash
git clone https://github.com/ergoracloud/ergora-specialists && cd ergora-specialists/mcp && npm install
claude mcp add ergora-specialists -e ERGORA_EMAIL=you@company.com -- node "$PWD/index.js"
```

Claude Desktop / Cursor — `claude_desktop_config.json` / `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "ergora-specialists": {
      "command": "node",
      "args": ["/absolute/path/to/ergora-specialists/mcp/index.js"],
      "env": { "ERGORA_EMAIL": "you@company.com" }
    }
  }
}
```

## Tools
- `ergora_sales`, `ergora_marketing`, `ergora_ads`, `ergora_content`, `ergora_ecommerce`, `ergora_entrepreneurship`, `ergora_business_strategy`, `ergora_community`, `ergora_creator`, `ergora_design`, `ergora_developer`, `ergora_finance`, `ergora_hr`, `ergora_leadership`, `ergora_legal`, `ergora_local`, `ergora_pr` — one per specialist. Input: `{ query, top_k?, email? }`.
- `ergora_ask` — cross-vertical (optionally `vertical`).
- `ergora_list_specialists` — what's available.

## Free tier
Your email is the access key: 30 queries/day. Supply it as the `X-Ergora-Email` header (remote), `ERGORA_EMAIL` (local), or the `email` tool argument. Without one, requests are limited to 5/day per IP. Fair use: about 30 requests per minute per caller; bursts beyond that get a `429`. Emails are only ever used for your quota and (if the domain accepts mail) an occasional Ergora update — no third-party sharing.

## How it works
Queries go to a Cloudflare Worker gateway which embeds the question and searches an **isolated** vector store of the Ergora knowledge base (never Ergora's production customer database). Results are summaries with links to the original sources — no verbatim reproduction.

## Architecture (this repo)
- `worker/` — Cloudflare Worker: remote MCP endpoint (`/mcp`) + JSON API (`/query`), Vectorize `ergora-kb`, KV rate-limit + lead capture. Deploy: `cd worker && npx wrangler deploy`.
- `mcp/` — the local stdio MCP server (thin client of `/query`). `node e2e-test.mjs` (stdio) and `node e2e-remote-test.mjs` (remote) are end-to-end checks against the live gateway.

MIT — see [LICENSE](LICENSE).
