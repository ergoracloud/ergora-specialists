#!/bin/bash
# Weekly Supabase -> ergora-kb-v2 (Vectorize) + ergora-kb-fts (D1) sync. Replaces /root/sync_vectorize.sh.
# Lives in /root/kb-v2 on KVM2 (cron: Saturdays 04:00). Credentials come from files only:
#   /root/.kb_sync_pg          postgresql:// URI of the least-privilege kb_sync_reader role (sync/sql/kb_sync_reader.sql)
#   /root/.sbkey               legacy PostgREST key, NOT used while PG_CONN_FILE is set (rollback: unset it)
#   /root/.cf_kb_v2_token      Cloudflare token: Workers AI Read+Edit, Vectorize Edit, D1 Edit (chmod 600)
#   /root/kb-v2/d1_id          the ergora-kb-fts database id
set -euo pipefail
cd /root/kb-v2
export PG_CONN_FILE=/root/.kb_sync_pg
export CF_TOKEN_FILE=/root/.cf_kb_v2_token
export D1_DATABASE_ID="$(cat /root/kb-v2/d1_id)"
export SOURCE_POLICY=/root/kb-v2/source_policy.json
exec /usr/bin/python3 -I /root/kb-v2/kb_v2_sync.py "$@"
