# Runbook: gateway v2 cutover (Workers AI + ergora-kb-v2 + D1 + Durable Object)

Every step below changes live Cloudflare or KVM2 state and **needs Tom's approval**. Run them in order.
Commands assume `cd ~/ergora-specialists/worker` (after this PR is merged) unless a step says otherwise.
Nothing here touches Supabase except read-only SELECTs, and nothing runs on KVM4.

SSH shorthand used below: `KVM2="ssh -i ~/.ssh/ergora_vps root@187.124.209.30"`.

## 0. Plan check and tokens (Tom)

1. Confirm the Workers plan: dash.cloudflare.com, account `c9edb4c8...`, Workers and Pages, Plans. This build
   assumes **Free**. On Paid nothing changes except more headroom (see `docs/COSTS.md`).
2. Deploy token (used by `wrangler` on the Mac, normally `CLOUDFLARE_WORKERS_TOKEN`). Add to it:
   - Account: **Workers Scripts Edit** (already has), **Vectorize Edit**, **D1 Edit**, **Workers AI Read**.
   Today it returns 403 on Workers AI and 401 on D1, so steps 3, 4 and 7 fail without this.
   Alternative: run `npx wrangler login` once and use the OAuth session instead of a token.
3. A **new** token for the KVM2 sync, named `kb-v2-sync`, scoped to this account only:
   - **Workers AI Read**, **Workers AI Edit**, **Vectorize Edit**, **D1 Edit**. Nothing else.
   Copy it, then install it without it ever appearing on screen:
   ```bash
   pbpaste | ssh -i ~/.ssh/ergora_vps root@187.124.209.30 'umask 077 && cat > /root/.cf_kb_v2_token'
   ```
4. Loops: create a transactional email "Confirm your email for Ergora Specialists" with a button linking to
   the data variable `confirmUrl`. Note its transactional id for step 6. (Optional: without it the gateway
   still runs; it just captures no leads.)

## 1. Local checks

```bash
cd ~/ergora-specialists/worker && npm ci && npm run check
python3 -I ../sync/test_kb_v2_sync.py -v
```
Expected: tsc and eslint clean, 25 vitest tests pass, preflight `--config-only` OK, `wrangler deploy --dry-run` bundles, 8 Python tests pass.

## 2. (Only if step 3 is refused) free the stored-dims allowance

The old index `ergora-kb` (1024d, about 21M stored dims) is already above the Free 5M cap. If Cloudflare
enforces the cap account-wide, creating or filling `ergora-kb-v2` fails. The old index is unusable
anyway (its Gemini query path is gone in v2). Deleting it is permanent, so do this **only after** v2 is
filled and serving, unless step 3 or step 7 actually fails with a quota error:
```bash
npx wrangler vectorize delete ergora-kb
```

## 3. Create the v2 index and its metadata index (before any upsert)

```bash
npx wrangler vectorize create ergora-kb-v2 --dimensions=384 --metric=cosine
npx wrangler vectorize create-metadata-index ergora-kb-v2 --propertyName=vertical --type=string
npx wrangler vectorize get ergora-kb-v2
npx wrangler vectorize list-metadata-index ergora-kb-v2
```

## 4. Create D1 and apply the FTS migration

```bash
npx wrangler d1 create ergora-kb-fts --location weur
```
Paste the printed `database_id` into `worker/wrangler.toml` (replacing the all-zero id), commit that one-line
change, and record it for the sync:
```bash
echo '<database_id>' | ssh -i ~/.ssh/ergora_vps root@187.124.209.30 'cat > /root/kb-v2/d1_id'
npx wrangler d1 migrations apply ergora-kb-fts --remote
npx wrangler d1 execute ergora-kb-fts --remote --command "SELECT count(*) AS n FROM kb_docs"
```
Expected: `n = 0`.

## 5. Model eval and the first sync (KVM2, nothing scheduled)

Files are already installed in `/root/kb-v2` (not in cron). If this PR changed them after review, copy again:
```bash
scp -i ~/.ssh/ergora_vps sync/kb_v2_sync.py sync/kb_v2_sync.sh sync/eval_models.py shared/source_policy.json root@187.124.209.30:/root/kb-v2/
```
Then:
```bash
$KVM2 'cd /root/kb-v2 && SB_KEY_FILE=/root/.sbkey CF_TOKEN_FILE=/root/.cf_kb_v2_token python3 -I eval_models.py'
```
Expected: about 440 neurons, `KEEP bge-small` (recall@5 gap of 5 points or less). Read
`/root/kb-v2/eval_out/side_by_side.md`. If it says bge-m3 is clearly better, stop: that needs Workers Paid
(`docs/COSTS.md`, about $5.37 a month).

```bash
$KVM2 '/root/kb-v2/kb_v2_sync.sh --dry-run'      # expect about 8,960 to upsert, 0 to delete, about 3.44M stored dims
$KVM2 '/root/kb-v2/kb_v2_sync.sh --limit 200'    # canary
npx wrangler vectorize info ergora-kb-v2         # vectorCount 200
$KVM2 '/root/kb-v2/kb_v2_sync.sh'                # full load
```
The full load stops by itself at 80,000 D1 rows written or 8,000 neurons in a day and prints `PARTIAL (re-run tomorrow to finish)`. If so, run the same command the next day (it only does the remaining rows).

## 6. Secrets and vars for the new Worker

Uptime hub alerts (80% and 100% of the daily cap, vector budget, upstream failures):
```bash
TOKEN=$(openssl rand -hex 32)
printf %s "$TOKEN" | npx wrangler secret put UPTIME_HUB_TOKEN
printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1   # add as "ergora-specialists" in SOURCE_TOKENS
unset TOKEN
```
Add that sha256 under the `ergora-specialists` key in `SOURCE_TOKENS` in `~/claude/uptime/hub/wrangler.toml`,
then deploy the hub (`cd ~/claude/uptime/hub && npx wrangler deploy`, with `CLOUDFLARE_WORKERS_TOKEN`).

Loops (optional, from step 0.4): set `LOOPS_CONFIRM_TEMPLATE_ID = "<id>"` in `worker/wrangler.toml`.
`LOOPS_API_KEY` already exists as a secret from v0.3; check with `npx wrangler secret list`.

## 7. Deploy (the Durable Object migration `v1` applies with it)

```bash
npm run deploy        # = preflight (real D1 id, v2 index, no GCP vars) && wrangler deploy
```

## 8. Smoke tests

```bash
BASE=https://ergora-specialists-gateway.contact-c9e.workers.dev
curl -s $BASE/health
curl -s $BASE/health/deep            # "ok": true, and each component shows "ok": true
curl -s -X POST $BASE/query -H 'content-type: application/json' -d '{"vertical":"ecom","query":"reduce cart abandonment","top_k":3}'
cd ../mcp && npm ci && node e2e-remote-test.mjs
npx wrangler tail ergora-specialists-gateway --format pretty   # watch a few minutes for errors
```

## 9. Remove the GCP path

```bash
npx wrangler secret delete GCP_SA_JSON
```
After this, revoke that service account key in GCP (IAM, Service accounts, Keys).

## 10. Switch the KVM2 weekly cron

Back up, then swap only the old sync line (old scripts stay on disk for rollback):
```bash
$KVM2 'crontab -l > /root/crontab.bak.$(date +%F) && crontab -l | grep -n sync_vectorize'
$KVM2 'crontab -l | sed "s#^0 4 \* \* 6 /root/sync_vectorize.sh.*#0 4 * * 6 /root/kb-v2/kb_v2_sync.sh >> /root/kb-v2/sync.log 2>\&1#" | crontab - && crontab -l | grep kb-v2'
```
`/root/load_all_vectorize.py` and `/root/sync_vectorize.sh` wrote Gemini vectors into `ergora-kb`; they are no
longer called. Once v2 has run for a week, the old index can go (step 2 command) and the old scripts can be
moved to `/root/archive/`.

## 11. Uptime monitor target

Add to `~/claude/uptime/monitor/targets.json`:
```json
{"id":"ergora-specialists","name":"Ergora Specialists MCP","url":"https://ergora-specialists-gateway.contact-c9e.workers.dev/health/deep","host":"Cloudflare","expect":"\"ok\"\\s*:\\s*true"}
```
Redeploy the monitor on KVM2 (scp `targets.json` to the monitor directory, then `docker compose up -d --force-recreate`).

## 12. Alert path test

`POST /admin/alert-test` sends one event (kind `test`, title "ergora-specialists alert test") to uptime-hub and
returns the hub's HTTP status. It needs the `ADMIN_TOKEN` secret (copy on Tom's Mac at `~/.ergora_mcp_admin_token`,
mode 600); without it the path answers 404. One test a minute. `{"notify": false}` skips Telegram.
```bash
curl -s -X POST -H "Authorization: Bearer $(cat ~/.ergora_mcp_admin_token)" \
  https://ergora-specialists-gateway.contact-c9e.workers.dev/admin/alert-test
```

## Rollback

`npx wrangler rollback` returns the Worker to v0.3 (KV and `ergora-kb` are untouched until step 2), but
v0.3 needs `GCP_SA_JSON`, so roll back **before** step 9. The cron backup from step 10 restores the old sync
(`crontab /root/crontab.bak.<date>`). Changing `PUBLIC_BASE_URL` later (for example to a custom domain) is a
var change plus a deploy; confirmation links then use that origin.
