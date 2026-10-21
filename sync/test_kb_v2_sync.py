"""Unit tests for the pure parts of kb_v2_sync.py (no network). Run: python3 -m unittest -v sync/test_kb_v2_sync.py"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb_v2_sync as s  # noqa: E402

ALLOWED, EXCLUDED = s.load_policy()
TEXT = json.loads((Path(__file__).resolve().parent.parent / "shared" / "text_cases.json").read_text())
CASES = json.loads((Path(__file__).resolve().parent.parent / "shared" / "policy_cases.json").read_text())["cases"]


def row(**kw):
    base = {"id": "3f1c", "title": "Cold email", "summary": "Keep it short.", "source_url": "https://www.close.com/blog/x", "audit_status": "recurated"}
    base.update(kw)
    return base


class Policy(unittest.TestCase):
    def test_parity_with_worker(self):
        for url, expected in CASES:
            self.assertEqual(s.is_allowed_source(url, ALLOWED, EXCLUDED), expected, url)

    def test_gate_row(self):
        self.assertEqual(s.gate_row("sales", row(), ALLOWED, EXCLUDED)["id"], "sales_3f1c")
        self.assertIsNone(s.gate_row("sales", row(audit_status="unreviewed"), ALLOWED, EXCLUDED))
        self.assertIsNone(s.gate_row("sales", row(summary="   "), ALLOWED, EXCLUDED))
        self.assertIsNone(s.gate_row("sales", row(source_url="https://hbr.org/x"), ALLOWED, EXCLUDED))
        self.assertIsNone(s.gate_row("sales", row(id="x" * 60), ALLOWED, EXCLUDED))
        d = s.gate_row("sales", row(summary="a" * 2000), ALLOWED, EXCLUDED)
        self.assertEqual(len(d["summary"]), 1200)

    def test_hash_changes_with_content_and_model(self):
        a = s.content_hash("sales", "t", "x", "https://close.com/a")
        self.assertNotEqual(a, s.content_hash("sales", "t", "y", "https://close.com/a"))
        self.assertIn(s.EMBED_MODEL, "@cf/baai/bge-small-en-v1.5")

    def test_embed_text_has_no_query_instruction(self):
        d = s.gate_row("sales", row(), ALLOWED, EXCLUDED)
        self.assertEqual(s.embed_text(d), "Cold email\nKeep it short.")
        self.assertNotIn("Represent this sentence", s.embed_text(d))


class TextHygiene(unittest.TestCase):
    def test_strip_parity_with_worker(self):
        for raw, expected in TEXT["strip"]:
            self.assertEqual(s.strip_links(raw), expected, raw)

    def test_title_parity_with_worker(self):
        for title, summary, expected in TEXT["titles"]:
            self.assertEqual(s.public_title(title, summary), expected, title)

    def test_gate_row_cleans_title_and_summary(self):
        d = s.gate_row("sales", row(title="https://www.gorgias.com/blog", summary="Reply fast. See [docs](https://evil.example/x)."), ALLOWED, EXCLUDED)
        self.assertEqual(d["title"], "Reply fast")
        self.assertEqual(d["summary"], "Reply fast. See docs.")
        self.assertIsNone(s.gate_row("sales", row(summary="https://only-a-link.example/x"), ALLOWED, EXCLUDED))


class Dedupe(unittest.TestCase):
    def doc(self, i, v="sales", url="https://www.close.com/blog/a", title="Cold email", summary="Keep it short and specific."):
        return {"id": f"{v}_{i}", "vertical": v, "title": title, "summary": summary, "source_url": url}

    def test_same_source_page_in_one_vertical_kept_once(self):
        docs = [self.doc(1), self.doc(2, url="https://close.com/blog/a/?utm_source=x", summary="Keep it short, specific and personal."),
                self.doc(3, url="https://www.close.com/blog/b", title="Follow ups", summary="Follow up four times.")]
        kept, dropped = s.dedupe(docs)
        self.assertEqual(sorted(d["id"] for d in kept), ["sales_2", "sales_3"])  # longest summary wins
        self.assertEqual(dropped, [("sales_1", "sales_2")])

    def test_same_page_in_two_verticals_is_kept_in_both(self):
        kept, dropped = s.dedupe([self.doc(1), self.doc(1, v="content")])
        self.assertEqual(len(kept), 2)
        self.assertEqual(dropped, [])

    def test_near_identical_text_from_different_urls(self):
        long = "Value based pricing beats cost plus pricing for most B2B SaaS products because buyers pay for outcomes not inputs"
        a = self.doc(1, url="https://www.close.com/blog/x", title="Pricing", summary=long)
        b = self.doc(2, url="https://www.close.com/blog/y", title="Pricing", summary=long + ".")
        c = self.doc(3, url="https://www.close.com/blog/z", title="Hiring", summary="Hire slowly and fire quickly.")
        kept, dropped = s.dedupe([a, b, c])
        self.assertEqual(len(kept), 2)
        self.assertEqual(len(dropped), 1)

    def test_source_key(self):
        self.assertEqual(s.source_key("https://www.a.com/p/x/?utm_medium=m&id=2"), "a.com/p/x?id=2")


class Postgres(unittest.TestCase):
    def test_pg_env_keeps_password_out_of_argv(self):
        env = s.pg_env("postgresql://kb_sync_reader.ref:p%40ss@aws-0-eu-west-2.pooler.supabase.com:5432/postgres")
        self.assertEqual(env["PGUSER"], "kb_sync_reader.ref")
        self.assertEqual(env["PGPASSWORD"], "p@ss")
        self.assertEqual(env["PGSSLMODE"], "require")
        self.assertEqual(env["PGPORT"], "5432")

    def test_select_is_read_only_and_scoped(self):
        sql = s.SELECT_SQL.format(table="sales_kb")
        self.assertTrue(sql.startswith("SELECT"))
        self.assertIn("audit_status = 'recurated'", sql)
        with self.assertRaises(ValueError):
            s.fetch_postgres("postgresql://u:p@h/db", ["sales_kb; drop table x"])


class Planning(unittest.TestCase):
    def test_plan_upserts_changed_and_deletes_ineligible(self):
        elig = {"a": {"id": "a", "hash": "1"}, "b": {"id": "b", "hash": "2"}, "c": {"id": "c", "hash": "3"}}
        manifest = {"a": "1", "b": "old", "z": "9"}
        up, dels = s.plan(elig, manifest)
        self.assertEqual(sorted(d["id"] for d in up), ["b", "c"])
        self.assertEqual(dels, ["z"])

    def test_delete_guard(self):
        self.assertIsNone(s.check_delete_guard(10, 9000, 8990, False))
        self.assertIn("under half", s.check_delete_guard(9000, 9000, 0, False))
        self.assertIn("over 20%", s.check_delete_guard(3000, 9000, 6000, False))
        self.assertIsNone(s.check_delete_guard(3000, 9000, 6000, True))
        self.assertIsNone(s.check_delete_guard(0, 0, 9000, False))

    def test_worker_and_sync_agree_on_model(self):
        cfg = (Path(__file__).resolve().parent.parent / "worker" / "src" / "config.ts").read_text()
        self.assertIn(f'EMBED_MODEL = "{s.EMBED_MODEL}"', cfg)
        self.assertIn(f"EMBED_DIMS = {s.EMBED_DIMS}", cfg)
        self.assertIn(f'EMBED_POOLING = "{s.EMBED_POOLING}"', cfg)


class D1Sql(unittest.TestCase):
    """Runs the real migration and the sync's SQL on SQLite FTS5 (the engine D1 uses)."""

    def setUp(self):
        import sqlite3
        self.db = sqlite3.connect(":memory:")
        try:
            self.db.execute("CREATE VIRTUAL TABLE _probe USING fts5(x)")
        except sqlite3.OperationalError:
            self.skipTest("this sqlite3 build has no FTS5")
        mig = (Path(__file__).resolve().parent.parent / "worker" / "migrations" / "0001_kb_fts.sql").read_text()
        self.db.executescript(mig)

    def _upsert(self, docs):
        params = []
        for d in docs:
            params += [d["id"], d["vertical"], d["title"], d["summary"], d["source_url"], d["hash"], "2026-10-21"]
        self.db.execute(s.upsert_sql(len(docs)), params)

    def _match(self, expr):
        return [r[0] for r in self.db.execute(
            "SELECT d.id FROM kb_fts JOIN kb_docs d ON d.rid = kb_fts.rowid WHERE kb_fts MATCH ? ORDER BY bm25(kb_fts, 4.0, 1.0, 0.0)", (expr,))]

    def test_insert_update_delete_keep_fts_in_sync(self):
        a = s.gate_row("sales", row(id="1", title="Cold email openers", summary="Short emails win."), ALLOWED, EXCLUDED)
        b = s.gate_row("marketing_fundamentals", row(id="2", title="Positioning", summary="Pick a category."), ALLOWED, EXCLUDED)
        self._upsert([a, b])
        self.assertEqual(self._match('{title summary} : ("cold")'), ["sales_1"])
        self.assertEqual(self._match('vertical : "marketing_fundamentals" AND {title summary} : ("category")'), ["marketing_fundamentals_2"])
        self.assertEqual(self._match('vertical : "sales" AND {title summary} : ("category")'), [])
        a2 = dict(a, summary="Warm intros beat cold outreach.", hash="new")
        self._upsert([a2])
        self.assertEqual(self._match('{title summary} : ("warm")'), ["sales_1"])
        self.assertEqual(self._match('{title summary} : ("short")'), [])  # old text gone from the index
        self.db.execute(s.delete_sql(1), ["sales_1"])
        self.assertEqual(self._match('{title summary} : ("warm")'), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM kb_docs").fetchone()[0], 1)
        self.db.execute("INSERT INTO kb_fts(kb_fts) VALUES('integrity-check')")


if __name__ == "__main__":
    unittest.main()
