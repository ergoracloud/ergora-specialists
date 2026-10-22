# Ergora Specialists gateway v2: cost and limit math

Design goal: run on the Cloudflare **Workers Free** plan at **$0/month**, with `GLOBAL_DAILY_LIMIT = 2,500`
queries a day (Tom, 2026-10-21). All numbers below are worst case: the cap hit every day of a 30-day month
(75,000 queries). Limits checked 2026-10-21 against the pages linked at the bottom.

## Corpus facts (read-only Supabase SELECT, 2026-10-21)

| Fact | Value |
|---|---|
| Recurated rows (17 `<v>_kb` tables) | 10,661 |
| Eligible after the gate (https, allowlisted host, not hbr.org / GitHub hosts, non-empty summary) | **8,960** |
| Distinct source hosts on the allowlist | 616 (`shared/source_policy.json`) |
| Average embedded text (title + summary[:1200]) | 226 chars, about 57 tokens; max 1,263 chars (about 316 tokens, under bge-small's 512) |
| Likely non-English rows | 25 to 27 of 10,661 (under 0.3%): rows with over 5% non-ASCII letters, or common Spanish, French, German, Italian or Dutch stopwords and no English ones |

The GitHub and hbr.org hosts account for 1,633 of the recurated rows (github.com 1,476, hbr.org 157). The old
loader only excluded hbr.org, so 1,476 GitHub rows were public. Policy: never cite GitHub hosts (insights rule), and hbr.org is excluded for ToS reasons.

## Model choice

| Model | Dims | Stored dims for 8,960 | Fits Free 5M? | English retrieval (MTEB, BAAI card) | Notes |
|---|---|---|---|---|---|
| **`@cf/baai/bge-small-en-v1.5`** (chosen) | 384 | **3.44M** | **Yes** (69%) | 51.68 | English only, 512 tokens, `pooling: "cls"` recommended by Cloudflare |
| `@cf/baai/bge-base-en-v1.5` | 768 | 6.88M | No | 53.25 | |
| `@cf/baai/bge-large-en-v1.5` | 1024 | 9.17M | No | 54.29 | |
| `@cf/baai/bge-m3` | 1024 | 9.17M | No | not on the card | Multilingual, 8K context, cheapest per token |
| `@cf/google/embeddinggemma-300m` | not stated | | | | Beta, unpriced: not for production |
| `@cf/qwen/qwen3-embedding-0.6b` | not stated | | | | |

No multilingual model in the current catalog is documented at 468 dims or fewer, so a Free-plan multilingual
option does not exist today. The KB is over 99.7% English with short passages, so bge-m3's strengths
(multilingual, long context) buy little here. On MTEB English retrieval bge-small is about 2.6 points below
bge-large-en. `sync/eval_models.py` measures the real gap on our KB (known-item recall@5 and top-5 overlap
vs bge-m3) before cutover: keep bge-small if the gap is 5 points or less.

## Free plan (chosen): $0/month

| Resource | Free allowance | Worst-case use at 2,500/day | Headroom / guard |
|---|---|---|---|
| Workers requests | 100,000/day | about 13,000/day (2,500 tool calls, about 3 MCP requests each for hosted clients, plus 2,880 health probes) | 87% spare |
| Workers CPU | 10 ms/request | JSON parse, one SHA-256, string formatting; AI, Vectorize, D1 and DO waits are I/O (not CPU) | the v0.3 Worker already ran on Free with RS256 JWT signing, which costs more CPU than v2 |
| Workers AI | 10,000 neurons/day | queries: 2,500 x ~30 tokens = 75K tokens x 1,841 neurons/M = **~138 neurons/day**; health: 288 x ~15 tokens, about 8 neurons | 98% spare. Full re-embed: 8,960 x ~57 tokens = 0.51M tokens = **~940 neurons** once (sync stops at 8,000) |
| Vectorize stored dims | 5,000,000 | 8,960 x 384 = **3,440,640** | room for 13,020 vectors; sync refuses to go over |
| Vectorize queried dims | 30,000,000/month, counted as (stored vectors + queries) x dims | (8,960 + 1,440 health + **66,000** budget) x 384 = **29.34M** | `VECTORIZE_MONTHLY_QUERY_BUDGET = 66000` (about 2,200/day on average). Without the guard the absolute worst case (75,000 + 1,440 + 8,960) x 384 = 32.8M would exceed 30M, so the last ~9,000 queries of such a month go to the D1 keyword fallback and Tom gets an alert. Cache hits do not count |
| Durable Objects (SQLite) | 100,000 requests, 100,000 rows written, 5M rows read per day; 5 GB | about 2 calls and up to 10 row writes per admitted query (global, open share, network, unconfirmed, /48, ASN, distinct-email and email counters): ~8,000 requests and ~25,000 writes a day at the cap (including health memo); rejections write nothing, and repeat refusals are answered from a per-isolate memo without a DO call | 75% spare. Cache rows (about 6 KB) expire after 24 h, daily alarm cleans up: under 50 MB stored |
| D1 | 5M rows read/day, 100,000 rows written/day, 500 MB per DB | storage about 30 to 40 MB (docs + FTS index); first load roughly 50,000 to 90,000 rows written; keyword queries read rows only in fallback mode | `D1_DAILY_ROWS_READ_BUDGET = 4000000`; sync stops at 80,000 writes and resumes next run |
| KV | 1,000 writes/day | **0** (counters moved to the DO) | removes the old "~333 queries/day then 429 for everyone" DoS |
| Per-minute limiter (30/min per network for queries, 10/min for `/health/deep`) | no extra resource | an isolate-local counter, then one counter row in the Gate DO inside the call each query and health probe already makes: **0 extra DO requests**, +1 row write per admitted query or probe (about 4,000 writes a day at the cap) | the Cloudflare Rate Limiting bindings were removed in 0.4.2: deployed, they never refused anything |
| Cache API | free | not used | quotas must be counted globally in the DO anyway, so the response cache lives in the DO (global, not per data centre, and certain to work on workers.dev) |
| **Total** | | | **$0/month** |

On Free, any limit that is exceeded makes that operation fail rather than bill. The guards above keep each
one below its limit, and the Worker degrades in this order: cache, semantic, keyword fallback, then a polite
"try again tomorrow or use Ergora" message. It never returns an upstream error.

## Paid alternatives (for comparison)

Workers Paid is $5/month and includes 10M stored + 50M queried Vectorize dims, 1M KV writes, and the same
10,000 free neurons/day, with Workers AI at $0.011 per 1,000 neurons beyond that.

| Path | Stored dims | Queried dims/month (worst case) | Vectorize overage | Workers AI | Monthly total |
|---|---|---|---|---|---|
| **Free + bge-small 384d (this PR)** | 3.44M | capped at 29.3M | n/a | $0 (138 neurons/day) | **$0.00** |
| Paid + bge-small 384d | 3.44M | (8,960 + 1,440 + 75,000) x 384 = 32.8M (under 50M) | $0 | $0 | **$5.00** |
| Paid + bge-m3 1024d | 9.17M (under 10M) | (8,960 + 1,440 + 75,000) x 1024 = 87.4M, so 37.4M over x $0.01/M | $0.37 | $0 (about 81 neurons/day) | **$5.37** worst case, $5.00 at low traffic |
| Paid + bge-m3 at all 10,661 recurated rows (no GitHub/hbr exclusion) | 10.92M, so 0.92M over x $0.05/100M | (10,661 + 1,440 + 75,000) x 1024 = 89.2M | $0.39 + $0.0005 | $0 | **$5.39** |

Switching to Paid later needs no code change: raise `VECTORIZE_MONTHLY_QUERY_BUDGET`, and for bge-m3 change
the three `EMBED_*` constants (Worker `src/config.ts` and `sync/kb_v2_sync.py`, enforced by a parity test),
create a 1024d index and re-run the sync.

## Sources

- Workers AI pricing (neurons, per-model rates): https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI models: https://developers.cloudflare.com/workers-ai/models/ and https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/
- Vectorize pricing (Free 5M stored / 30M queried; formula example): https://developers.cloudflare.com/vectorize/platform/pricing/
- Vectorize limits: https://developers.cloudflare.com/vectorize/platform/limits/
- Workers limits (100,000 requests/day, 10 ms CPU, Cache API): https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects pricing (Free plan is SQLite-backed only): https://developers.cloudflare.com/durable-objects/platform/pricing/
- D1 limits and pricing: https://developers.cloudflare.com/d1/platform/limits/ and https://developers.cloudflare.com/d1/platform/pricing/
- KV pricing (1,000 writes/day on Free): https://developers.cloudflare.com/kv/platform/pricing/
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cache API: https://developers.cloudflare.com/workers/runtime-apis/cache/
- BGE v1.5 scores and query instruction: https://huggingface.co/BAAI/bge-small-en-v1.5
- Claude hosted connector egress range: https://claude.com/docs/connectors/building/authentication
