#!/usr/bin/env python3
"""Retrieval A/B for the public KB: bge-small-en-v1.5 (384d, fits Vectorize Free) vs bge-m3 (1024d, needs Paid).

The old Gemini index can't be the baseline (Vertex is 403 and the plan removes it), so this compares the two
Workers AI candidates on the real gated KB:

 1. Known-item retrieval: corpus = a stratified sample of eligible docs embedded as `title\\nsummary`;
    queries = a paraphrase-like probe built from each probe doc's summary (its first sentence, title removed),
    so the title can't be matched verbatim. Reports recall@1, recall@5 and MRR.
 2. Natural questions (3 per vertical): top-5 overlap between the models, plus a side-by-side Markdown file
    for a quick human relevance read (sync/eval_out/side_by_side.md).

Decision rule (printed): keep bge-small if its recall@5 is within 5 points of bge-m3 and the side-by-side read
shows no vertical where it is clearly worse.

Cost: ~2,500 texts per model, ~0.15M tokens each = ~280 neurons (bge-small) + ~160 (bge-m3), well inside the
10,000 free neurons/day. Read-only on Supabase.

Needs the same files as kb_v2_sync.py: SB_KEY_FILE and CF_TOKEN_FILE (Workers AI Read+Edit).
Usage: python3 eval_models.py [--corpus 2000] [--probes 300]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb_v2_sync as s  # noqa: E402

MODELS = {
    "bge-small": {"id": "@cf/baai/bge-small-en-v1.5", "extra": {"pooling": "cls"}, "q_prefix": "Represent this sentence for searching relevant passages: "},
    "bge-m3": {"id": "@cf/baai/bge-m3", "extra": {}, "q_prefix": ""},
}

QUESTIONS = {
    "sales": ["how to write a cold email that gets replies", "how to handle the price objection", "building a sales pipeline from scratch"],
    "marketing_fundamentals": ["how to position a new product", "what is a marketing funnel", "brand awareness vs performance marketing"],
    "ads": ["how to lower cost per acquisition on Meta ads", "Google Ads bidding strategy for small budgets", "how to test ad creative"],
    "content": ["how to do keyword research for a blog", "content distribution strategy", "how often should I publish"],
    "ecom": ["how to reduce cart abandonment", "email flows for a Shopify store", "improve ecommerce conversion rate"],
    "entrepreneurship": ["how to validate a startup idea", "when to raise a seed round", "finding product market fit"],
    "business_strategy": ["how to set OKRs", "competitive moat for a small company", "how to do a SWOT analysis"],
    "community": ["how to grow an online community", "community engagement ideas", "moderation guidelines for a forum"],
    "creator": ["how to grow a YouTube channel", "ways creators make money", "building a newsletter audience"],
    "design": ["usability testing on a budget", "how to build a design system", "mobile form design best practices"],
    "developer": ["how to design a scalable API", "monitoring and alerting for a web app", "code review best practices"],
    "finance": ["SaaS metrics investors care about", "how to manage cash flow", "how to value an early stage startup"],
    "hr": ["how to run a structured interview", "employee onboarding checklist", "performance review process"],
    "leadership_management": ["how to give difficult feedback", "running effective one on ones", "delegating as a new manager"],
    "legal": ["how to protect a trademark", "what should be in a SaaS contract", "GDPR basics for a small business"],
    "local": ["how to rank in Google local results", "getting more Google reviews", "local SEO for a restaurant"],
    "pr": ["how to pitch a journalist", "crisis communication plan", "writing a press release"],
}


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(v):
    n = math.sqrt(dot(v, v)) or 1.0
    return [x / n for x in v]


def embed_all(cf: s.Cloudflare, model: dict, texts: list[str], batch: int = 50) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), batch):
        r = cf._json(f"/ai/run/{model['id']}", {"text": texts[i:i + batch], **model["extra"]})
        data = (r.get("result") or {}).get("data") or []
        if len(data) != len(texts[i:i + batch]):
            raise RuntimeError(f"{model['id']}: unexpected response shape")
        out += [norm(v) for v in data]
    return out


def topk(qv, corpus_vecs, k=5):
    scores = [(dot(qv, cv), j) for j, cv in enumerate(corpus_vecs)]
    scores.sort(reverse=True)
    return [j for _, j in scores[:k]]


def probe_query(doc: dict) -> str:
    first = re.split(r"(?<=[.!?])\s+", doc["summary"].strip())[0]
    for w in set(re.findall(r"[A-Za-z]{5,}", doc["title"])):
        first = re.sub(rf"\b{re.escape(w)}\b", "", first, flags=re.I)
    return re.sub(r"\s+", " ", first).strip()[:300]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=int, default=2000)
    ap.add_argument("--probes", type=int, default=300)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    random.seed(a.seed)

    allowed, excluded = s.load_policy()
    rest = os.environ.get("SUPABASE_REST", "https://yqrrjmgjtvbhodpiqole.supabase.co/rest/v1")
    raw = s.fetch_supabase(s.read_secret("SB_KEY_FILE", "/root/.sbkey"), rest, s.VERTS)
    by_v = {v: [d for r in rows if (d := s.gate_row(v, r, allowed, excluded))] for v, rows in raw.items()}
    per_v = max(1, a.corpus // len(by_v))
    corpus = [d for v in by_v for d in random.sample(by_v[v], min(per_v, len(by_v[v])))]
    probes = [d for d in random.sample(corpus, min(a.probes, len(corpus))) if len(probe_query(d).split()) >= 5]
    print(f"corpus {len(corpus)} docs, {len(probes)} known-item probes, {sum(len(q) for q in QUESTIONS.values())} questions", flush=True)

    cf = s.Cloudflare(s.read_secret("CF_TOKEN_FILE", "/root/.cf_kb_v2_token"), os.environ.get("CF_ACCT", "c9edb4c8373162e323c2718a364afc62"), "unused", "unused")
    doc_texts = [s.embed_text(d) for d in corpus]
    index_of = {d["id"]: i for i, d in enumerate(corpus)}
    report, tops = {}, {}
    for name, m in MODELS.items():
        cvecs = embed_all(cf, m, doc_texts)
        pvecs = embed_all(cf, m, [m["q_prefix"] + probe_query(d) for d in probes])
        r1 = r5 = mrr = 0.0
        for d, qv in zip(probes, pvecs):
            ranked = topk(qv, cvecs, 10)
            target = index_of[d["id"]]
            if target in ranked:
                rank = ranked.index(target) + 1
                mrr += 1 / rank
                r1 += rank == 1
                r5 += rank <= 5
        n = len(probes) or 1
        report[name] = {"recall@1": round(r1 / n, 3), "recall@5": round(r5 / n, 3), "mrr@10": round(mrr / n, 3), "dims": len(cvecs[0])}
        qs = [(v, q) for v, ql in QUESTIONS.items() for q in ql]
        qvecs = embed_all(cf, m, [m["q_prefix"] + q for _, q in qs])
        tops[name] = {q: topk(qv, cvecs, 5) for (_, q), qv in zip(qs, qvecs)}
        print(name, json.dumps(report[name]), flush=True)

    overlap = [len(set(tops["bge-small"][q]) & set(tops["bge-m3"][q])) / 5 for q in tops["bge-small"]]
    report["top5_overlap_mean"] = round(sum(overlap) / len(overlap), 3)
    out = Path(__file__).resolve().parent / "eval_out"
    out.mkdir(exist_ok=True)
    lines = ["# bge-small vs bge-m3, top 3 per question\n"]
    for v, ql in QUESTIONS.items():
        lines.append(f"\n## {v}\n")
        for q in ql:
            lines.append(f"\n**{q}**\n")
            for name in MODELS:
                lines.append(f"- {name}: " + " / ".join(corpus[j]["title"][:70] for j in tops[name][q][:3]))
    (out / "side_by_side.md").write_text("\n".join(lines) + "\n")
    (out / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    gap = report["bge-m3"]["recall@5"] - report["bge-small"]["recall@5"]
    verdict = "KEEP bge-small (Free plan)" if gap <= 0.05 else "bge-small is >5 points worse: consider bge-m3 on Workers Paid"
    print(json.dumps(report), f"\nrecall@5 gap (m3 - small): {gap:+.3f} -> {verdict}\nside by side: {out / 'side_by_side.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
