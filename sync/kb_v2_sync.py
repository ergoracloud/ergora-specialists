#!/usr/bin/env python3
"""Supabase KB -> Cloudflare (Vectorize `ergora-kb-v2` + D1 `ergora-kb-fts`) sync for the public MCP.

Replaces /root/load_all_vectorize.py. Differences that matter:
  * Only GATED rows: audit_status = 'recurated', https source on shared/source_policy.json, non-empty summary.
  * Embeds title + summary text itself with Workers AI @cf/baai/bge-small-en-v1.5 (384d, cls pooling), the same
    model as the Worker's query side. It never reads the Gemini `embedding` column (that column was ~10 KB a row
    of Supabase egress every week).
  * DELETES vectors that are no longer eligible. The D1 table kb_docs is the manifest (id + content_hash), so the
    job is incremental: unchanged rows are skipped, changed rows re-embedded, removed rows deleted from both stores.
  * Guards: refuses mass deletes, refuses to exceed the Vectorize Free stored-dimension cap, stays inside the
    D1 Free 100,000 rows-written/day and Workers AI 10,000 neurons/day allowances (resumes on the next run).

Read-only on Supabase (PostgREST GETs). Writes only to the Cloudflare index and D1 database named below.

Credentials are read from files (never from argv, never printed):
  SB_KEY_FILE    default /root/.sbkey             Supabase key with read access to the 17 <vertical>_kb tables
  CF_TOKEN_FILE  default /root/.cf_kb_v2_token    Cloudflare token: Workers AI Read+Edit, Vectorize Edit, D1 Edit
Required env: D1_DATABASE_ID (from `wrangler d1 create ergora-kb-fts`).
Optional env: CF_ACCT, KB_INDEX (default ergora-kb-v2), SUPABASE_REST.

Usage:
  python3 kb_v2_sync.py --dry-run            # read everything, print the plan, write nothing
  python3 kb_v2_sync.py                      # apply (incremental)
  python3 kb_v2_sync.py --limit 200          # first real run: only 200 upserts, to smoke-test end to end
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
POLICY_PATH = Path(os.environ.get("SOURCE_POLICY", HERE.parent / "shared" / "source_policy.json"))

EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"  # MUST match worker/src/config.ts
EMBED_DIMS = 384
EMBED_POOLING = "cls"
NEURONS_PER_M_TOKENS = 1841  # https://developers.cloudflare.com/workers-ai/platform/pricing/
FREE_STORED_DIMS = 5_000_000  # Vectorize Free: https://developers.cloudflare.com/vectorize/platform/pricing/

VERTS = [
    "ads", "business_strategy", "community", "content", "creator", "design", "developer", "ecom",
    "entrepreneurship", "finance", "hr", "leadership_management", "legal", "local", "marketing_fundamentals",
    "pr", "sales",
]


# ── policy (mirrors worker/src/policy.ts) ─────────────────────────────────────────────────────────────
def load_policy(path: Path = POLICY_PATH) -> tuple[set[str], list[str]]:
    d = json.loads(path.read_text())
    return {h.lower() for h in d["hosts"]}, [h.lower() for h in d["excluded"]]


def normalise_host(host: str) -> str:
    h = host.lower().rstrip(".")
    return h[4:] if h.startswith("www.") else h


def is_allowed_source(url: str, allowed: set[str], excluded: list[str]) -> bool:
    if not isinstance(url, str) or len(url) > 400:
        return False
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if u.scheme != "https" or u.username or u.password or u.port or not u.hostname:
        return False
    host = normalise_host(u.hostname)
    if any(host == d or host.endswith("." + d) for d in excluded):
        return False
    return host in allowed


def content_hash(vertical: str, title: str, summary: str, source_url: str) -> str:
    raw = "\x1f".join([EMBED_MODEL, EMBED_POOLING, vertical, title, summary, source_url])
    return hashlib.sha256(raw.encode()).hexdigest()


def gate_row(vertical: str, row: dict, allowed: set[str], excluded: list[str]) -> dict | None:
    """Returns the public document for an eligible row, else None."""
    if row.get("audit_status") != "recurated":
        return None
    url = (row.get("source_url") or "").strip()
    if not is_allowed_source(url, allowed, excluded):
        return None
    summary = (row.get("summary") or "").strip()[:1200]
    if not summary:
        return None
    title = (row.get("title") or "").strip()[:200]
    vid = f"{vertical}_{row['id']}"
    if len(vid.encode()) > 64:  # Vectorize id limit
        return None
    return {
        "id": vid,
        "vertical": vertical,
        "title": title,
        "summary": summary,
        "source_url": url,
        "hash": content_hash(vertical, title, summary, url),
    }


def embed_text(doc: dict) -> str:
    # Documents are embedded WITHOUT the query instruction (BGE convention).
    return f"{doc['title']}\n{doc['summary']}" if doc["title"] else doc["summary"]


def upsert_sql(n_rows: int) -> str:
    return (
        "INSERT INTO kb_docs (id, vertical, title, summary, source_url, content_hash, updated_at) VALUES "
        + ",".join(["(?,?,?,?,?,?,?)"] * n_rows)
        + " ON CONFLICT(id) DO UPDATE SET vertical=excluded.vertical, title=excluded.title, summary=excluded.summary,"
        " source_url=excluded.source_url, content_hash=excluded.content_hash, updated_at=excluded.updated_at"
    )


def delete_sql(n_ids: int) -> str:
    return f"DELETE FROM kb_docs WHERE id IN ({','.join('?' * n_ids)})"


def plan(eligible: dict[str, dict], manifest: dict[str, str]) -> tuple[list[dict], list[str]]:
    upserts = [d for i, d in eligible.items() if manifest.get(i) != d["hash"]]
    deletes = sorted(i for i in manifest if i not in eligible)
    return upserts, deletes


def check_delete_guard(n_delete: int, n_manifest: int, n_eligible: int, allow_mass: bool) -> str | None:
    if allow_mass or n_manifest == 0:
        return None
    if n_eligible < 0.5 * n_manifest:
        return f"eligible set ({n_eligible}) is under half the manifest ({n_manifest}): Supabase read looks wrong"
    if n_delete > max(50, 0.2 * n_manifest):
        return f"{n_delete} deletes is over 20% of {n_manifest}: re-run with --allow-mass-delete if intended"
    return None


# ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────────
def read_secret(env_name: str, default_path: str) -> str:
    p = Path(os.environ.get(env_name, default_path))
    if not p.exists():
        sys.exit(f"missing credential file {p} (set {env_name})")
    return p.read_text().strip()


def http(url: str, *, method: str = "GET", headers: dict | None = None, body: bytes | None = None, timeout: int = 120, tries: int = 5):
    for attempt in range(tries):
        req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode(errors="replace")
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise RuntimeError(f"{method} {urllib.parse.urlsplit(url).path} -> HTTP {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise RuntimeError(f"{method} {urllib.parse.urlsplit(url).path} -> {e}") from None
    raise RuntimeError("unreachable")


class Cloudflare:
    def __init__(self, token: str, acct: str, index: str, d1_id: str):
        self.h = {"Authorization": f"Bearer {token}"}
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{acct}"
        self.index = index
        self.d1_id = d1_id
        self.d1_rows_written = 0
        self.d1_rows_read = 0
        self.neurons = 0.0

    def _json(self, path: str, payload, method: str = "POST"):
        return http(self.base + path, method=method, headers={**self.h, "Content-Type": "application/json"}, body=json.dumps(payload).encode())

    def index_info(self) -> dict:
        r = http(f"{self.base}/vectorize/v2/indexes/{self.index}", headers=self.h)
        return r["result"]

    def metadata_indexes(self) -> list[str]:
        r = http(f"{self.base}/vectorize/v2/indexes/{self.index}/metadata_index/list", headers=self.h)
        return [m.get("propertyName") for m in (r.get("result") or {}).get("metadataIndexes", [])]

    def d1(self, sql: str, params: list | None = None) -> list[dict]:
        r = self._json(f"/d1/database/{self.d1_id}/query", {"sql": sql, "params": params or []})
        out = []
        for res in r.get("result") or []:
            meta = res.get("meta") or {}
            self.d1_rows_written += int(meta.get("rows_written") or 0)
            self.d1_rows_read += int(meta.get("rows_read") or 0)
            out.extend(res.get("results") or [])
        return out

    def embed(self, texts: list[str]) -> list[list[float]]:
        r = self._json(f"/ai/run/{EMBED_MODEL}", {"text": texts, "pooling": EMBED_POOLING})
        data = (r.get("result") or {}).get("data") or []
        if len(data) != len(texts) or any(len(v) != EMBED_DIMS for v in data):
            raise RuntimeError("Workers AI returned an unexpected embedding shape")
        self.neurons += sum(len(t) for t in texts) / 4 / 1_000_000 * NEURONS_PER_M_TOKENS
        return data

    def upsert(self, vectors: list[dict]) -> None:
        nd = "\n".join(json.dumps(v) for v in vectors).encode()
        http(f"{self.base}/vectorize/v2/indexes/{self.index}/upsert", method="POST",
             headers={**self.h, "Content-Type": "application/x-ndjson"}, body=nd)

    def delete_vectors(self, ids: list[str]) -> None:
        for i in range(0, len(ids), 100):
            self._json(f"/vectorize/v2/indexes/{self.index}/delete_by_ids", {"ids": ids[i:i + 100]})


def fetch_supabase(sb_key: str, rest: str, verticals: list[str]) -> dict[str, list[dict]]:
    h = {"apikey": sb_key, "Authorization": f"Bearer {sb_key}"}
    out: dict[str, list[dict]] = {}
    for v in verticals:
        rows: list[dict] = []
        off = 0
        while True:
            q = urllib.parse.urlencode({
                "select": "id,title,summary,source_url,audit_status",
                "audit_status": "eq.recurated",
                "order": "id",
                "limit": "1000",
                "offset": str(off),
            })
            b = http(f"{rest}/{v}_kb?{q}", headers=h, timeout=90)
            rows += b
            off += len(b)
            if len(b) < 1000:
                break
            time.sleep(0.3)  # be gentle with the shared Supabase pool (max_connections=60)
        out[v] = rows
    return out


# ── main ──────────────────────────────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="read and plan only; no Cloudflare writes, no embeddings")
    ap.add_argument("--limit", type=int, default=0, help="max upserts this run (0 = no limit)")
    ap.add_argument("--batch", type=int, default=50, help="texts per Workers AI call / vectors per upsert")
    ap.add_argument("--max-d1-writes", type=int, default=80_000, help="stop upserting when D1 rows_written reaches this (Free: 100,000/day)")
    ap.add_argument("--max-neurons", type=float, default=8_000, help="stop embedding at this many estimated neurons (Free: 10,000/day)")
    ap.add_argument("--allow-mass-delete", action="store_true")
    ap.add_argument("--allow-over-free", action="store_true", help="permit more than 5M stored dims (Workers Paid only)")
    a = ap.parse_args(argv)

    allowed, excluded = load_policy()
    acct = os.environ.get("CF_ACCT", "c9edb4c8373162e323c2718a364afc62")
    d1_id = os.environ.get("D1_DATABASE_ID", "")
    if not d1_id:
        sys.exit("set D1_DATABASE_ID (from `wrangler d1 create ergora-kb-fts`)")
    rest = os.environ.get("SUPABASE_REST", "https://yqrrjmgjtvbhodpiqole.supabase.co/rest/v1")
    cf = Cloudflare(read_secret("CF_TOKEN_FILE", "/root/.cf_kb_v2_token"), acct, os.environ.get("KB_INDEX", "ergora-kb-v2"), d1_id)
    t0 = time.time()
    print(f"=== kb_v2_sync {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {'(dry run)' if a.dry_run else ''} ===", flush=True)

    info = cf.index_info()
    dims = (info.get("config") or {}).get("dimensions")
    if dims != EMBED_DIMS:
        sys.exit(f"index {cf.index} has {dims} dimensions, expected {EMBED_DIMS}")
    if "vertical" not in cf.metadata_indexes():
        sys.exit(f"index {cf.index} has no `vertical` metadata index: create it BEFORE the first upsert (RUNBOOK step 3)")

    raw = fetch_supabase(read_secret("SB_KEY_FILE", "/root/.sbkey"), rest, VERTS)
    eligible: dict[str, dict] = {}
    skipped = 0
    for v, rows in raw.items():
        for r in rows:
            d = gate_row(v, r, allowed, excluded)
            if d:
                eligible[d["id"]] = d
            else:
                skipped += 1
    print(f"supabase: {sum(len(r) for r in raw.values())} recurated rows, {len(eligible)} eligible, {skipped} gated out", flush=True)

    stored = len(eligible) * EMBED_DIMS
    if stored > FREE_STORED_DIMS and not a.allow_over_free:
        sys.exit(f"{len(eligible)} x {EMBED_DIMS} = {stored:,} stored dims is over the Vectorize Free cap ({FREE_STORED_DIMS:,})")

    manifest = {r["id"]: r["content_hash"] for r in cf.d1("SELECT id, content_hash FROM kb_docs")}
    upserts, deletes = plan(eligible, manifest)
    print(f"plan: manifest {len(manifest)}, upsert {len(upserts)}, delete {len(deletes)}", flush=True)
    guard = check_delete_guard(len(deletes), len(manifest), len(eligible), a.allow_mass_delete)
    if guard:
        sys.exit(f"refusing to delete: {guard}")
    if a.dry_run:
        print(json.dumps({"dry_run": True, "eligible": len(eligible), "upsert": len(upserts), "delete": len(deletes),
                          "stored_dims": stored, "est_neurons": round(sum(len(embed_text(d)) for d in upserts) / 4 / 1e6 * NEURONS_PER_M_TOKENS)}))
        return 0

    # 1. deletes first (vectors, then manifest rows), so removed rows stop being public right away
    if deletes:
        cf.delete_vectors(deletes)
        for i in range(0, len(deletes), 90):
            chunk = deletes[i:i + 90]
            cf.d1(delete_sql(len(chunk)), chunk)
        print(f"deleted {len(deletes)}", flush=True)

    # 2. upserts: embed -> Vectorize -> D1 (manifest written last, so a crash just re-embeds next run)
    done = 0
    todo = upserts[: a.limit] if a.limit else upserts
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for i in range(0, len(todo), a.batch):
        if cf.d1_rows_written >= a.max_d1_writes:
            print(f"stopping: D1 rows_written {cf.d1_rows_written} reached --max-d1-writes; next run resumes", flush=True)
            break
        if cf.neurons >= a.max_neurons:
            print(f"stopping: ~{cf.neurons:.0f} neurons reached --max-neurons; next run resumes", flush=True)
            break
        batch = todo[i:i + a.batch]
        vecs = cf.embed([embed_text(d) for d in batch])
        cf.upsert([
            {"id": d["id"], "values": v, "metadata": {
                "vertical": d["vertical"], "title": d["title"], "summary": d["summary"],
                "source_url": d["source_url"], "status": "approved"}}
            for d, v in zip(batch, vecs)
        ])
        for j in range(0, len(batch), 14):  # 7 params a row, D1 allows 100 bound params a statement
            rows = batch[j:j + 14]
            params: list = []
            for d in rows:
                params += [d["id"], d["vertical"], d["title"], d["summary"], d["source_url"], d["hash"], now]
            cf.d1(upsert_sql(len(rows)), params)
        done += len(batch)
        if done % 1000 < a.batch:
            print(f"  upserted {done}/{len(todo)}", flush=True)

    remaining = len(upserts) - done
    print(json.dumps({"eligible": len(eligible), "deleted": len(deletes), "upserted": done, "remaining": remaining,
                      "d1_rows_written": cf.d1_rows_written, "d1_rows_read": cf.d1_rows_read,
                      "est_neurons": round(cf.neurons), "seconds": round(time.time() - t0)}), flush=True)
    print(f"=== {'COMPLETE' if remaining == 0 else 'PARTIAL (re-run tomorrow to finish)'} ===", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
