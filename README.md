# Ergora Specialists MCP

17 business-vertical knowledge specialists (Sales, Marketing, Paid Ads, Content, Ecommerce, Entrepreneurship, Business Strategy, Community, Creator, Design & UX, Developer, Finance, HR, Leadership, Legal, Local Marketing, PR) as tools for Claude Desktop, Claude Code, Cursor and any MCP client.

Each tool returns summarised, **cited** insights from a curated knowledge base of leading practitioners, best-selling books and academic/regulatory sources. Free tier: 5 queries/day anonymous, 30/day with an email.

> Ergora runs all 17 of these as full AI specialist agents with unlimited use: https://ergora.app

## Install: remote server (nothing to download)

Server URL: **`https://ergora-specialists-gateway.contact-c9e.workers.dev/mcp`** (MCP Streamable HTTP, no auth)

**Claude Code**
```bash
claude mcp add --transport http ergora-specialists https://ergora-specialists-gateway.contact-c9e.workers.dev/mcp --header "X-Ergora-Email: you@company.com"
```

**Claude Desktop / claude.ai**: Settings, Connectors, *Add custom connector*, then paste the server URL. There is no login step; when Claude asks, give it your email to unlock 30 queries/day (it passes it in the tool's `email` argument).

**Cursor**: `.cursor/mcp.json`:
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

**Any other MCP client**: point it at the URL with the Streamable HTTP transport. The server is stateless (POST-only, JSON responses). The optional `X-Ergora-Email` header identifies you for the 30/day free tier.

## Install: local stdio server (npm)

Package: [`ergora-specialists-mcp`](https://www.npmjs.com/package/ergora-specialists-mcp) (Node 18+).

**Claude Code**
```bash
claude mcp add ergora-specialists -e ERGORA_EMAIL=you@company.com -- npx -y ergora-specialists-mcp
```

Claude Desktop / Cursor: `claude_desktop_config.json` / `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "ergora-specialists": {
      "command": "npx",
      "args": ["-y", "ergora-specialists-mcp"],
      "env": { "ERGORA_EMAIL": "you@company.com" }
    }
  }
}
```

From source instead: `git clone https://github.com/ergoracloud/ergora-specialists && cd ergora-specialists/mcp && npm install`, then point `command` at `node /absolute/path/to/mcp/index.js`.

## Tools
- `ergora_sales`, `ergora_marketing`, `ergora_ads`, `ergora_content`, `ergora_ecommerce`, `ergora_entrepreneurship`, `ergora_business_strategy`, `ergora_community`, `ergora_creator`, `ergora_design`, `ergora_developer`, `ergora_finance`, `ergora_hr`, `ergora_leadership`, `ergora_legal`, `ergora_local`, `ergora_pr`: one per specialist. Input: `{ query, top_k?, email? }`.
- `ergora_ask`: cross-vertical (optionally `vertical`).
- `ergora_list_specialists`: what's available.

## Free tier
Your email is the access key: 30 queries/day. Supply it as the `X-Ergora-Email` header (remote), `ERGORA_EMAIL` (local), or the `email` tool argument. Without one, requests are limited to 5/day per IP. Fair use: about 30 requests per minute per caller; bursts beyond that get a `429`.

The whole service also has a shared daily limit (2,500 queries a day). When it is reached every caller gets a clear "try again tomorrow (00:00 UTC) or use Ergora" message until the next UTC day.

The first time you use an email we send one message asking you to confirm it. Only confirmed addresses are added to Ergora's mailing list (for an occasional update, unsubscribe any time). Unconfirmed emails are used for your quota only. No third-party sharing.

## How it works
Queries go to a Cloudflare Worker gateway which embeds the question with Workers AI (`bge-small-en-v1.5`) and searches an **isolated** vector store of the Ergora knowledge base (never Ergora's production customer database). Only approved entries whose source is on a reviewed allowlist are returned. Results are summaries with links to the original sources, with no verbatim reproduction. If vector search is unavailable or over budget the gateway answers from a keyword index of the same entries and says so.

## Architecture (this repo)
- `worker/`: Cloudflare Worker (TypeScript), built to run on the Workers Free plan.
  - `/mcp` remote MCP endpoint, `POST /query` JSON API, `/health` and `/health/deep`, `/confirm` email confirmation.
  - Vectorize `ergora-kb-v2` (384d) for semantic search, D1 `ergora-kb-fts` (FTS5) for the keyword fallback, Workers AI for query embeddings.
  - A SQLite Durable Object (`Gate`) holds the quotas, the 24 h response cache, alert flags and pending email confirmations.
  - `PUBLIC_BASE_URL` sets the public origin used in confirmation links (empty means the request origin), so a custom domain needs only a var change.
  - `npm run check` runs typecheck, lint, tests and a dry-run bundle. Deploy with `npm run deploy` (preflight first), following `docs/RUNBOOK_v2.md`.
- `sync/`: weekly KB sync (`kb_v2_sync.py`, runs on Ergora's background server): reads approved rows, applies the shared source policy, embeds with the same model as the Worker and removes entries that are no longer eligible. `eval_models.py` compares embedding models on the real KB.
- `shared/source_policy.json`: the source allowlist used by both the Worker and the sync.
- `mcp/`: the local stdio MCP server (thin client of `/query`). `node e2e-test.mjs` (stdio) and `node e2e-remote-test.mjs` (remote) are end-to-end checks against the live gateway.
- `docs/COSTS.md`: free-plan limit math and the Free vs Paid comparison.

MIT, see [LICENSE](LICENSE).
