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

  * Text hygiene (mirrors worker/src/policy.ts, parity cases in shared/text_cases.json): URLs and markdown links
    are stripped from titles and summaries, and a title that is a bare URL is replaced by the summary's first
    sentence. Near-duplicates inside a vertical (same source page, or almost the same title + summary) are
    loaded once. Supabase rows are never modified.

Read-only on Supabase. Writes only to the Cloudflare index and D1 database named below.

Supabase access (least privilege): set PG_CONN_FILE to a file holding a postgresql:// URI for the
`kb_sync_reader` role (SELECT on id, title, summary, source_url, audit_status of the 17 <vertical>_kb tables
only, recurated rows only via RLS). Rows are read with psql; the password goes to psql through PGPASSWORD, never
argv. Without PG_CONN_FILE the old PostgREST path with SB_KEY_FILE is used (rollback only).

Credentials are read from files (never from argv, never printed):
  PG_CONN_FILE   e.g. /root/.kb_sync_pg            postgresql:// URI of kb_sync_reader (preferred)
  SB_KEY_FILE    default /root/.sbkey             legacy: Supabase key for PostgREST (only if PG_CONN_FILE unset)
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
import re
import subprocess
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


# ── text hygiene (mirrors worker/src/policy.ts) ──────────────────────────────────────────────────────
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
ANGLE_URL = re.compile(r"<(?:https?://|www\.)[^>\s]*>", re.I)
BARE_URL = re.compile(r"(?:https?://|www\.)[^\s<>()\[\]]+", re.I)
BARE_URL_TITLE = re.compile(r"^\s*(?:https?://|www\.)\S*\s*$", re.I)


def strip_links(text: str) -> str:
    t = MD_IMAGE.sub(r"\1", text)
    t = MD_LINK.sub(r"\1", t)
    t = ANGLE_URL.sub(" ", t)
    t = BARE_URL.sub(" ", t)
    t = re.sub(r"\(\s*\)|\[\s*\]", " ", t)
    t = re.sub(r"[ \t]+([.,;:!?])", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


def title_from_summary(summary: str, max_len: int = 120) -> str:
    s = strip_links(summary)
    m = re.match(r"^(.+?[.!?])(?:\s|$)", s)
    t = re.sub(r"[.!?]+$", "", m.group(1) if m else s).strip()
    if len(t) > max_len:
        cut = t[: max_len + 1]
        sp = cut.rfind(" ")
        t = re.sub(r"[\s,;:]+$", "", cut[:sp] if sp > 40 else t[:max_len]) + "..."
    return t


def public_title(title: str, summary: str) -> str:
    t = "" if BARE_URL_TITLE.match(title) else strip_links(title)
    return (t or title_from_summary(summary))[:200]


def source_key(url: str) -> str:
    """Same page, whatever the www., trailing slash or utm_ parameters (mirrors sourceKey in worker/src/search.ts)."""
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    q = "&".join(f"{k}={v}" for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True) if not k.lower().startswith("utm_"))
    return f"{host}{u.path.rstrip('/')}" + (f"?{q}" if q else "")


def _tokens(d: dict) -> frozenset[str]:
    return frozenset(re.findall(r"[a-z0-9]+", f"{d['title']} {d['summary']}".lower()))


def dedupe(docs: list[dict], threshold: float = 0.9) -> tuple[list[dict], list[tuple[str, str]]]:
    """Within each vertical keep one doc per source page and drop near-identical title + summary (token Jaccard
    >= threshold). The kept doc is the one with the longest summary (ties: smallest id). Returns (kept, [(dropped, kept)])."""
    dropped: list[tuple[str, str]] = []
    by_vertical: dict[str, list[dict]] = {}
    for d in docs:
        by_vertical.setdefault(d["vertical"], []).append(d)
    kept_all: list[dict] = []
    for _v, group in sorted(by_vertical.items()):
        group = sorted(group, key=lambda d: (-len(d["summary"]), d["id"]))
        by_src: dict[str, dict] = {}
        first_pass: list[dict] = []
        for d in group:
            k = source_key(d["source_url"])
            if k in by_src:
                dropped.append((d["id"], by_src[k]["id"]))
                continue
            by_src[k] = d
            first_pass.append(d)
        kept: list[tuple[dict, frozenset[str]]] = []
        for d in first_pass:
            tok = _tokens(d)
            twin = None
            for other, otok in kept:
                lo, hi = sorted((len(tok), len(otok)))
                if not hi or lo / hi < threshold:
                    continue
                if len(tok & otok) / len(tok | otok) >= threshold:
                    twin = other
                    break
            if twin:
                dropped.append((d["id"], twin["id"]))
            else:
                kept.append((d, tok))
        kept_all.extend(d for d, _ in kept)
    return kept_all, dropped


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
    summary = strip_links(row.get("summary") or "")[:1200].strip()
    if not summary:
        return None
    title = public_title((row.get("title") or "").strip(), summary)
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


SELECT_SQL = (
    "SELECT json_build_object('id', id, 'title', title, 'summary', summary, 'source_url', source_url, "
    "'audit_status', audit_status) FROM public.{table} WHERE audit_status = 'recurated' ORDER BY id"
)


def pg_env(uri: str) -> dict[str, str]:
    """libpq environment for psql from a postgresql:// URI (keeps the password out of argv)."""
    u = urllib.parse.urlsplit(uri)
    if u.scheme not in ("postgres", "postgresql") or not u.hostname or not u.username:
        sys.exit("PG_CONN_FILE must hold a postgresql://user:password@host:port/db URI")
    params = dict(urllib.parse.parse_qsl(u.query))
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update({
        "PGHOST": u.hostname,
        "PGPORT": str(u.port or 5432),
        "PGUSER": urllib.parse.unquote(u.username),
        "PGPASSWORD": urllib.parse.unquote(u.password or ""),
        "PGDATABASE": (u.path or "/postgres").lstrip("/") or "postgres",
        "PGSSLMODE": params.get("sslmode", "require"),
        "PGCONNECT_TIMEOUT": "20",
        "PGAPPNAME": "kb_v2_sync",
    })
    return env


def fetch_postgres(uri: str, verticals: list[str]) -> dict[str, list[dict]]:
    env = pg_env(uri)
    out: dict[str, list[dict]] = {}
    for v in verticals:
        if v not in VERTS:
            raise ValueError(v)
        r = subprocess.run(
            ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "SET statement_timeout = '60s'", "-c", SELECT_SQL.format(table=f"{v}_kb")],
            env=env, capture_output=True, text=True, timeout=180,
        )
        if r.returncode != 0:
            # psql errors never contain the password (it is not in argv or the URI we pass)
            raise RuntimeError(f"psql read of {v}_kb failed: {r.stderr.strip()[:300]}")
        out[v] = [json.loads(line) for line in r.stdout.splitlines() if line.strip()]
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

    if os.environ.get("PG_CONN_FILE"):
        raw = fetch_postgres(read_secret("PG_CONN_FILE", ""), VERTS)
        source = "postgres (kb_sync_reader)"
    else:
        raw = fetch_supabase(read_secret("SB_KEY_FILE", "/root/.sbkey"), rest, VERTS)
        source = "postgrest (legacy key)"
    gated: list[dict] = []
    skipped = 0
    for v, rows in raw.items():
        for r in rows:
            d = gate_row(v, r, allowed, excluded)
            if d:
                gated.append(d)
            else:
                skipped += 1
    kept, dupes = dedupe(gated)
    eligible: dict[str, dict] = {d["id"]: d for d in kept}
    retitled = sum(1 for v, rows in raw.items() for r in rows if BARE_URL_TITLE.match(r.get("title") or "") or not (r.get("title") or "").strip())
    print(f"supabase via {source}: {sum(len(r) for r in raw.values())} recurated rows, {len(gated)} pass the gate, "
          f"{skipped} gated out, {len(dupes)} near-duplicates dropped, {retitled} titles derived from the summary, "
          f"{len(eligible)} eligible", flush=True)

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
        print("sample duplicates (dropped -> kept):", dupes[:5], flush=True)
        print(json.dumps({"dry_run": True, "eligible": len(eligible), "duplicates": len(dupes), "upsert": len(upserts), "delete": len(deletes),
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
