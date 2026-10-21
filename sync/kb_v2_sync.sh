#!/bin/bash
# Weekly Supabase -> ergora-kb-v2 (Vectorize) + ergora-kb-fts (D1) sync. Replaces /root/sync_vectorize.sh.
# Lives in /root/kb-v2 on KVM2. NOT scheduled until RUNBOOK step 10. Credentials come from files only:
#   /root/.sbkey               existing Supabase read key (same one the old job used)
#   /root/.cf_kb_v2_token      Cloudflare token: Workers AI Read+Edit, Vectorize Edit, D1 Edit (chmod 600)
#   /root/kb-v2/d1_id          the ergora-kb-fts database id
set -euo pipefail
cd /root/kb-v2
export SB_KEY_FILE=/root/.sbkey
export CF_TOKEN_FILE=/root/.cf_kb_v2_token
export D1_DATABASE_ID="$(cat /root/kb-v2/d1_id)"
export SOURCE_POLICY=/root/kb-v2/source_policy.json
exec /usr/bin/python3 -I /root/kb-v2/kb_v2_sync.py "$@"
