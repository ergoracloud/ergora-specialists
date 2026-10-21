import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetIsolateState } from "../src/query";
import { call, meta, migrate, mocks, OK_URL, postQuery, rpc, seedDocs, stubFetch, testEnv } from "./helpers";

beforeAll(migrate);
beforeEach(() => _resetIsolateState());
afterEach(() => vi.restoreAllMocks());

const DOCS = [
  { id: "sales_1", vertical: "sales", title: "Cold email that gets replies", summary: "Short cold email with one clear ask converts best.", source_url: "https://www.close.com/blog/cold-email" },
  { id: "sales_2", vertical: "sales", title: "Poisoned row", summary: "cold email from a host that is not allowed", source_url: "https://evil.example.com/cold-email" },
  { id: "finance_1", vertical: "finance", title: "SaaS cash flow", summary: "Cold email is not a finance topic but this mentions it.", source_url: "https://www.tomtunguz.com/x" },
];

describe("semantic query path", () => {
  it("embeds with Workers AI (bge-small, cls, query instruction) and returns gated results", async () => {
    stubFetch();
    const m = mocks([
      { score: 0.8123, metadata: meta() },
      { score: 0.7, metadata: meta({ source_url: "https://evil.example.com/x" }) },
      { score: 0.69, metadata: meta({ status: "unreviewed" }) },
      { score: 0.6, metadata: meta({ source_url: "javascript:alert(1)" }) },
    ]);
    const e = testEnv(m);
    const res = await postQuery(e, { query: "How should I price my SaaS?", vertical: "sales", topK: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ source_url: string; score: number }>; meta: Record<string, unknown> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ source_url: OK_URL, score: 0.812 });
    expect(body.meta).toMatchObject({ mode: "semantic", identity: "ip", vertical: "sales" });
    const [model, input] = m.ai.run.mock.calls[0] as unknown as [string, { text: string[]; pooling: string }];
    expect(model).toBe("@cf/baai/bge-small-en-v1.5");
    expect(input.pooling).toBe("cls");
    expect(input.text[0]).toMatch(/^Represent this sentence for searching relevant passages: How should I price/);
    const [, opts] = m.kb.query.mock.calls[0] as unknown as [number[], { filter: unknown; topK: number }];
    expect(opts.filter).toEqual({ vertical: { $eq: "sales" } });
  });

  it("answers repeats from the Gate cache without calling Workers AI or Vectorize again", async () => {
    stubFetch();
    const m = mocks();
    const e = testEnv(m);
    await postQuery(e, { query: "pricing saas" }, { email: "a@b.co" });
    const res = await postQuery(e, { query: "  Pricing   SaaS? " }, { email: "a@b.co" });
    const body = (await res.json()) as { meta: { mode: string; remaining_today: number } };
    expect(body.meta.mode).toBe("cache");
    expect(body.meta.remaining_today).toBe(2);
    expect(m.ai.run).toHaveBeenCalledTimes(1);
    expect(m.kb.query).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown verticals and empty queries with fixed public codes", async () => {
    const e = testEnv(mocks());
    const r1 = await postQuery(e, { query: "x", vertical: "__proto__" });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { code: string }).code).toBe("UNKNOWN_VERTICAL");
    const r2 = await postQuery(e, { query: "   " });
    expect(((await r2.json()) as { code: string }).code).toBe("BAD_REQUEST");
  });
});

describe("fallback and error hygiene", () => {
  it("falls back to D1 keyword search when Workers AI fails, alerts once, leaks nothing", async () => {
    await seedDocs(DOCS);
    const f = stubFetch();
    const m = mocks();
    m.ai.run.mockRejectedValue(new Error("embed 403 upstream secret detail"));
    const e = testEnv(m);
    const res = await postQuery(e, { query: "cold email", vertical: "sales" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/403|secret detail|workers-ai/);
    const body = JSON.parse(text) as { results: Array<{ title: string; score: null }>; meta: { mode: string } };
    expect(body.meta.mode).toBe("keyword");
    expect(body.results.map((r) => r.title)).toEqual(["Cold email that gets replies"]); // poisoned host + other vertical dropped
    expect(body.results[0].score).toBeNull();
    await postQuery(e, { query: "cold email again", vertical: "sales" }, { ip: "203.0.113.8" });
    const alerts = f.hub().filter((c) => JSON.stringify(c.body).includes("specialists_upstream"));
    expect(alerts).toHaveLength(1);
  });

  it("returns UPSTREAM_UNAVAILABLE (no internals) when every backend fails", async () => {
    stubFetch();
    const m = mocks();
    m.ai.run.mockRejectedValue(new Error("boom"));
    const brokenD1 = { prepare: () => { throw new Error("D1_ERROR: no such table kb_fts"); } } as unknown as D1Database;
    const e = testEnv(m, { KB_FTS: brokenD1 });
    const res = await postQuery(e, { query: "cold email" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(body.error).not.toMatch(/D1|kb_fts|boom/);
  });

  it("switches to keyword mode once the monthly Vectorize budget is used, and alerts", async () => {
    await seedDocs(DOCS);
    const f = stubFetch();
    const m = mocks();
    const e = testEnv(m, { VECTORIZE_MONTHLY_QUERY_BUDGET: "1" });
    await postQuery(e, { query: "pricing one" }, { email: "v@b.co" });
    const res = await postQuery(e, { query: "cold email two" }, { email: "v@b.co" });
    expect(((await res.json()) as { meta: { mode: string } }).meta.mode).toBe("keyword");
    expect(m.kb.query).toHaveBeenCalledTimes(1);
    expect(f.hub().some((c) => JSON.stringify(c.body).includes("specialists-vector-budget-"))).toBe(true);
  });
});

describe("quotas and the daily cap", () => {
  it("enforces the anonymous per-IP quota with a polite message", async () => {
    stubFetch();
    const e = testEnv(mocks());
    for (let i = 0; i < 2; i++) expect((await postQuery(e, { query: `q${i}` })).status).toBe(200);
    const res = await postQuery(e, { query: "q3" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("DAILY_LIMIT_REACHED");
    expect(body.error).toMatch(/Add an email/);
  });

  it("gives a hosted-client pool its own larger allowance", async () => {
    stubFetch();
    const e = testEnv(mocks());
    for (let i = 0; i < 5; i++) expect((await postQuery(e, { query: `p${i}` }, { ip: `160.79.10${4 + (i % 4)}.9` })).status).toBe(200);
    expect((await postQuery(e, { query: "p6" }, { ip: "160.79.111.1" })).status).toBe(429);
  });

  it("alerts at 80% and at the cap once each, then refuses politely without touching backends", async () => {
    const f = stubFetch();
    const m = mocks();
    const e = testEnv(m); // GLOBAL_DAILY_LIMIT=10 in wrangler.test.toml
    for (let i = 0; i < 10; i++) {
      const r = await postQuery(e, { query: `cap ${i}` }, { email: `u${i}@b.co`, ip: `198.51.100.${i}` });
      expect(r.status).toBe(200);
    }
    const over = await postQuery(e, { query: "one more" }, { email: "late@b.co", ip: "198.51.100.200" });
    expect(over.status).toBe(429);
    const body = (await over.json()) as { code: string; error: string };
    expect(body.code).toBe("SERVICE_DAILY_LIMIT");
    expect(body.error).toMatch(/try again tomorrow/);
    expect(body.error).toMatch(/https:\/\/ergora\.app/);
    await postQuery(e, { query: "and another" }, { email: "late2@b.co", ip: "198.51.100.201" });
    const capAlerts = f.hub().filter((c) => JSON.stringify(c.body).includes("specialists_cap"));
    expect(capAlerts).toHaveLength(2);
    expect(JSON.stringify(capAlerts[0].body)).toMatch(/specialists-cap-warning-/);
    expect(JSON.stringify(capAlerts[1].body)).toMatch(/specialists-cap-reached-/);
    expect(m.ai.run).toHaveBeenCalledTimes(10);
  });
});

describe("email confirmation before Loops", () => {
  it("sends a confirmation email (no PII in the link) and only creates the contact after POST /confirm", async () => {
    const f = stubFetch();
    const e = testEnv(mocks());
    await postQuery(e, { query: "hiring plan", vertical: "hr" }, { email: "Lead@Example.com" });
    const tx = f.calls.find((c) => c.url === "https://app.loops.so/api/v1/transactional");
    expect(tx).toBeTruthy();
    const confirmUrl = (tx!.body as { dataVariables: { confirmUrl: string } }).dataVariables.confirmUrl;
    expect(confirmUrl).toMatch(/^https:\/\/mcp\.example\.test\/confirm\?t=[0-9a-f]{64}$/);
    expect(confirmUrl.toLowerCase()).not.toContain("lead");
    expect(f.calls.some((c) => c.url.includes("contacts/create"))).toBe(false);

    // a second query does not resend
    await postQuery(e, { query: "hiring plan 2", vertical: "hr" }, { email: "lead@example.com" });
    expect(f.calls.filter((c) => c.url.endsWith("/transactional"))).toHaveLength(1);

    const t = new URL(confirmUrl).searchParams.get("t")!;
    const page = await call(e, `/confirm?t=${t}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('method="post"');
    expect(f.calls.some((c) => c.url.includes("contacts/create"))).toBe(false); // GET (link scanners) confirms nothing

    const form = new URLSearchParams({ t });
    const ok = await call(e, "/confirm", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(ok.status).toBe(200);
    const created = f.calls.filter((c) => c.url.includes("contacts/create"));
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ email: "lead@example.com", userGroup: "mcp-lead", firstVertical: "hr" });
    const again = await call(e, "/confirm", { method: "POST", body: new URLSearchParams({ t }), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(again.status).toBe(410);
  });

  it("does not email undeliverable domains", async () => {
    const f = stubFetch((url) => (url.includes("dns-query") ? Response.json({ Status: 3 }) : undefined));
    const e = testEnv(mocks());
    await postQuery(e, { query: "x" }, { email: "who@nowhere-at-all.invalid" });
    expect(f.calls.some((c) => c.url.includes("loops.so"))).toBe(false);
  });

  it("stores nothing and sends nothing when Loops confirmation is not configured", async () => {
    const f = stubFetch();
    const e = testEnv(mocks(), { LOOPS_CONFIRM_TEMPLATE_ID: "" });
    await postQuery(e, { query: "x" }, { email: "a@b.co" });
    expect(f.calls.some((c) => c.url.includes("loops.so"))).toBe(false);
  });
});

describe("health", () => {
  it("/health is shallow; /health/deep checks every backend and memoises", async () => {
    stubFetch();
    await seedDocs(DOCS);
    const m = mocks();
    const e = testEnv(m);
    const shallow = (await (await call(e, "/health")).json()) as { ok: boolean; mcp: string };
    expect(shallow).toMatchObject({ ok: true, mcp: "https://mcp.example.test/mcp" });
    expect(m.ai.run).not.toHaveBeenCalled();

    const deep = await call(e, "/health/deep");
    expect(deep.status).toBe(200);
    const d = (await deep.json()) as { ok: boolean; embed: { ok: boolean }; vectorize: { queried: boolean }; keyword: { ok: boolean } };
    expect(d).toMatchObject({ ok: true, embed: { ok: true }, vectorize: { queried: true }, keyword: { ok: true } });
    await call(e, "/health/deep");
    expect(m.ai.run).toHaveBeenCalledTimes(1);
    expect(m.kb.query).toHaveBeenCalledTimes(1);
  });

  it("/health/deep reports 503 with booleans only when Workers AI is down", async () => {
    const f = stubFetch();
    await seedDocs(DOCS);
    const m = mocks();
    m.ai.run.mockRejectedValue(new Error("embed 403 billing"));
    const e = testEnv(m);
    const res = await call(e, "/health/deep");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toMatch(/"ok":false/);
    expect(text).not.toMatch(/403|billing/);
    expect(f.hub().length).toBe(1);
  });
});

describe("remote MCP", () => {
  it("initialize, tools/list and tools/call work; quota text is friendly", async () => {
    stubFetch();
    const e = testEnv(mocks());
    const init = (await (await rpc(e, "initialize", { protocolVersion: "2025-06-18" })).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = (await (await rpc(e, "tools/list")).json()) as { result: { tools: unknown[] } };
    expect(list.result.tools).toHaveLength(19);
    const res = (await (await rpc(e, "tools/call", { name: "ergora_sales", arguments: { query: "pricing" } })).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain(`Source: ${OK_URL}`);
    expect(res.result.content[0].text).toMatch(/anonymous queries remaining today/);
    const unknown = (await (await rpc(e, "tools/call", { name: "nope", arguments: {} })).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
  });
});
