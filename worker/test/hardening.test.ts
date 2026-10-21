// Abuse hardening (October 2026 review): H1 email rotation, H2 burst limiter + memo + batches, H3 IPv6 /48, ASN and
// the global reserve, M1 confirmation rules, M2 no CORS, M3 pooled clients, L1 /health/deep, L3 lead retention,
// L4 links in output.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Gate } from "../src/gate";
import { _resetIsolateState } from "../src/query";
import { call, countingGate, fakeLimiter, gateOf, meta, migrate, mocks, postQuery, seedDocs, stubFetch, testEnv } from "./helpers";

beforeAll(migrate);
beforeEach(() => _resetIsolateState());
afterEach(() => vi.restoreAllMocks());

type Body = { code?: string; error?: string; meta?: { identity: string; remaining_today: number } };
const body = async (r: Response) => (await r.json()) as Body;

const sql = (e: ReturnType<typeof testEnv>, q: string, ...args: unknown[]) =>
  runInDurableObject(gateOf(e) as unknown as DurableObjectStub<Gate>, (_i, state) => state.storage.sql.exec(q, ...args).toArray());

async function confirmVia(e: ReturnType<typeof testEnv>, f: ReturnType<typeof stubFetch>, email: string, ip: string) {
  await postQuery(e, { query: `subscribe ${email}`, subscribe: true }, { email, ip });
  const tx = f.calls.filter((c) => c.url.endsWith("/transactional")).at(-1)!;
  const t = new URL((tx.body as { dataVariables: { confirmUrl: string } }).dataVariables.confirmUrl).searchParams.get("t")!;
  const ok = await call(e, "/confirm", { method: "POST", body: new URLSearchParams({ t }), headers: { "content-type": "application/x-www-form-urlencoded" }, ip });
  expect(ok.status).toBe(200);
}

describe("H1: email rotation from one network", () => {
  it("counts +tags, case and gmail dots as one mailbox", async () => {
    stubFetch();
    const e = testEnv(mocks(), { LOOPS_CONFIRM_TEMPLATE_ID: "" }); // DAILY_LIMIT=4
    for (const em of ["john.doe@gmail.com", "JohnDoe+a@gmail.com", "j.o.h.n.doe+b@googlemail.com", "johndoe@gmail.com"])
      expect((await postQuery(e, { query: `q ${em}` }, { email: em })).status).toBe(200);
    const r = await postQuery(e, { query: "q5" }, { email: "john.d.oe+zzz@gmail.com" });
    expect(r.status).toBe(429);
    expect((await body(r)).error).toMatch(/your free daily limit/);
  });

  it("caps distinct emails per network at 3 and the network's unconfirmed total", async () => {
    stubFetch();
    const e = testEnv(mocks(), { LOOPS_CONFIRM_TEMPLATE_ID: "" }); // MAX_EMAILS_PER_NET=3, NET_UNCONFIRMED_LIMIT=5
    for (const em of ["a@x.co", "b@x.co", "c@x.co"]) expect((await postQuery(e, { query: em }, { email: em })).status).toBe(200);
    const fourth = await postQuery(e, { query: "d" }, { email: "d@x.co" });
    expect(fourth.status).toBe(429);
    const b4 = await body(fourth);
    expect(b4.code).toBe("TOO_MANY_EMAILS");
    expect(b4.error).not.toMatch(/[–—]/);
    // an email already seen today keeps working until the network's unconfirmed total (5) is used
    expect((await postQuery(e, { query: "a2" }, { email: "a@x.co" })).status).toBe(200);
    expect((await postQuery(e, { query: "b2" }, { email: "b@x.co" })).status).toBe(200);
    const over = await postQuery(e, { query: "c2" }, { email: "c@x.co" });
    expect(over.status).toBe(429);
    expect((await body(over)).error).toMatch(/unconfirmed emails on this network/);
    // another network is unaffected
    expect((await postQuery(e, { query: "d" }, { email: "d@x.co", ip: "198.51.100.77" })).status).toBe(200);
  });

  it("a confirmed email gets the full network ceiling and skips the unconfirmed caps", async () => {
    const f = stubFetch();
    const e = testEnv(mocks(), { IP_DAILY_LIMIT: "9" });
    const ip = "203.0.113.50";
    await confirmVia(e, f, "lead@example.com", ip); // 1 query (unconfirmed at the time)
    const first = await postQuery(e, { query: "confirmed 1" }, { email: "lead@example.com", ip });
    expect(first.status).toBe(200);
    // use up the unconfirmed allowance (5) on this network: 1 above + 2 anonymous + 2 by another email
    await postQuery(e, { query: "anon 1" }, { ip });
    await postQuery(e, { query: "anon 2" }, { ip });
    await postQuery(e, { query: "o1" }, { email: "other@example.com", ip });
    await postQuery(e, { query: "o2" }, { email: "other@example.com", ip });
    expect((await postQuery(e, { query: "o3" }, { email: "other@example.com", ip })).status).toBe(429);
    const ok = await postQuery(e, { query: "confirmed 2" }, { email: "lead@example.com", ip });
    expect(ok.status).toBe(200);
    expect((await body(ok)).meta?.identity).toBe("email");
  });
});

describe("H2: burst limiter, memo and batches", () => {
  it("keys the burst limiter on the network, never on the email", async () => {
    stubFetch();
    const { keys, limiter } = fakeLimiter();
    const e = testEnv(mocks(), { BURST: limiter, LOOPS_CONFIRM_TEMPLATE_ID: "" });
    for (const em of ["a@x.co", "b@x.co", "c@x.co", "d@x.co"]) await postQuery(e, { query: "q" }, { email: em, ip: "198.51.100.9" });
    expect(new Set(keys)).toEqual(new Set(["v4:198.51.100.9"]));
  });

  it("refuses at the edge without touching the Durable Object when the burst limit trips", async () => {
    stubFetch();
    const m = mocks();
    const e = testEnv(m, { BURST: fakeLimiter(() => false).limiter });
    const g = countingGate(e);
    e.GATE_DO = g.ns;
    const r = await postQuery(e, { query: "q" });
    expect(r.status).toBe(429);
    expect((await body(r)).code).toBe("RATE_LIMITED");
    expect(g.calls()).toBe(0);
    expect(m.ai.run).not.toHaveBeenCalled();
  });

  it("memoises refusals per isolate so repeat offenders stop reaching the Durable Object", async () => {
    stubFetch();
    const e = testEnv(mocks(), { LOOPS_CONFIRM_TEMPLATE_ID: "" });
    const g = countingGate(e);
    e.GATE_DO = g.ns;
    await postQuery(e, { query: "1" });
    await postQuery(e, { query: "2" });
    expect((await postQuery(e, { query: "3" })).status).toBe(429); // reaches the DO, refused (anon 2)
    const before = g.calls();
    for (let i = 0; i < 5; i++) expect((await postQuery(e, { query: `again ${i}` })).status).toBe(429);
    expect(g.calls()).toBe(before);
    // rotating emails after the distinct-email cap: one DO refusal, then memo
    for (const em of ["a@x.co", "b@x.co", "c@x.co"]) await postQuery(e, { query: em }, { email: em });
    expect((await postQuery(e, { query: "d" }, { email: "d@x.co" })).status).toBe(429);
    const mid = g.calls();
    for (const em of ["e@x.co", "f@x.co", "g@x.co"]) expect((await postQuery(e, { query: em }, { email: em })).status).toBe(429);
    expect(g.calls()).toBe(mid);
  });

  it("caps MCP batches at 5 and spends one burst token per HTTP request", async () => {
    stubFetch();
    const { keys, limiter } = fakeLimiter();
    const e = testEnv(mocks(), { BURST: limiter, DAILY_LIMIT: "20", LOOPS_CONFIRM_TEMPLATE_ID: "" });
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "ergora_sales", arguments: { query: `b${i}`, email: "a@x.co" } } }));
    const big = await call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch(6)) });
    expect(big.status).toBe(400);
    expect(keys).toHaveLength(0);
    const ok = await call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch(5)) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as unknown[]).length).toBe(5);
    expect(keys).toHaveLength(1);
    // initialize and tools/list do not spend tokens
    await call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(keys).toHaveLength(1);
  });

  it("answers a rate-limited MCP request with JSON-RPC errors and 429", async () => {
    stubFetch();
    const e = testEnv(mocks(), { BURST: fakeLimiter(() => false).limiter });
    const r = await call(e, "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ergora_sales", arguments: { query: "x" } } }),
    });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ id: 7, error: { code: -32000 } });
  });
});

describe("H3: IPv6 /48, ASN and the global reserve", () => {
  it("caps unconfirmed traffic per IPv6 /48 across rotated /64s", async () => {
    stubFetch();
    const e = testEnv(mocks()); // V6_48_LIMIT=4, ANON_LIMIT=2
    for (let i = 0; i < 4; i++) expect((await postQuery(e, { query: `v6 ${i}` }, { ip: `2001:db8:7:${i + 1}::1` })).status).toBe(200);
    expect((await postQuery(e, { query: "v6 5" }, { ip: "2001:db8:7:99::1" })).status).toBe(429);
    expect((await postQuery(e, { query: "other 48" }, { ip: "2001:db8:8:1::1" })).status).toBe(200);
  });

  it("caps unconfirmed traffic per ASN", async () => {
    stubFetch();
    const e = testEnv(mocks(), { GLOBAL_DAILY_LIMIT: "100" }); // ASN_LIMIT=7
    for (let i = 0; i < 7; i++) expect((await postQuery(e, { query: `asn ${i}` }, { ip: `198.51.100.${i + 1}`, asn: 64500 })).status).toBe(200);
    expect((await postQuery(e, { query: "asn 8" }, { ip: "198.51.100.50", asn: 64500 })).status).toBe(429);
    expect((await postQuery(e, { query: "other asn" }, { ip: "198.51.100.51", asn: 64501 })).status).toBe(200);
  });

  it("keeps 30% of the global cap for the hosted-client pool and confirmed emails", async () => {
    stubFetch();
    const e = testEnv(mocks()); // GLOBAL_DAILY_LIMIT=10, GLOBAL_RESERVE_PCT=30 -> 7 open
    for (let i = 0; i < 7; i++) expect((await postQuery(e, { query: `open ${i}` }, { ip: `192.0.2.${i + 1}` })).status).toBe(200);
    const r = await postQuery(e, { query: "open 8" }, { ip: "192.0.2.100" });
    expect(r.status).toBe(429);
    expect((await body(r)).code).toBe("SERVICE_DAILY_LIMIT");
    expect((await postQuery(e, { query: "pool 1" }, { ip: "160.79.104.10" })).status).toBe(200);
  });
});

describe("M3: hosted-client pool", () => {
  it("lowers the per-email limit for unconfirmed addresses inside the pool", async () => {
    stubFetch();
    const e = testEnv(mocks(), { LOOPS_CONFIRM_TEMPLATE_ID: "" }); // POOL_UNCONFIRMED_EMAIL_LIMIT=2
    const ip = "160.79.104.20";
    expect((await postQuery(e, { query: "p1" }, { email: "u@x.co", ip })).status).toBe(200);
    expect((await postQuery(e, { query: "p2" }, { email: "u@x.co", ip })).status).toBe(200);
    expect((await postQuery(e, { query: "p3" }, { email: "u@x.co", ip })).status).toBe(429);
    // many users share the pool, so there is no distinct-email cap there
    for (const em of ["v@x.co", "w@x.co", "y@x.co"]) expect((await postQuery(e, { query: em }, { email: em, ip })).status).toBe(200);
  });

  it("caps all unconfirmed pool traffic", async () => {
    stubFetch();
    const e = testEnv(mocks(), { LOOPS_CONFIRM_TEMPLATE_ID: "", GLOBAL_DAILY_LIMIT: "100" }); // POOL_UNCONFIRMED_LIMIT=7
    for (let i = 0; i < 7; i++) expect((await postQuery(e, { query: `p${i}` }, { email: `p${i}@x.co`, ip: "160.79.104.21" })).status).toBe(200);
    expect((await postQuery(e, { query: "p8" }, { email: "p8@x.co", ip: "160.79.104.22" })).status).toBe(429);
  });
});

describe("M1: confirmation emails only after real use", () => {
  const sent = (f: ReturnType<typeof stubFetch>) => f.calls.filter((c) => c.url.endsWith("/transactional"));

  it("sends nothing on first use; sends after 3 queries across 2 days", async () => {
    const f = stubFetch();
    const e = testEnv(mocks());
    for (let i = 0; i < 3; i++) await postQuery(e, { query: `use ${i}` }, { email: "real@example.com" });
    expect(sent(f)).toHaveLength(0); // 3 queries, but one day
    await sql(e, "UPDATE lead_use SET last_day = '2000-01-01' WHERE email = ?", "real@example.com");
    await postQuery(e, { query: "next day" }, { email: "real@example.com", ip: "198.51.100.30" });
    expect(sent(f)).toHaveLength(1);
    expect((sent(f)[0].body as { email: string }).email).toBe("real@example.com");
  });

  it("allows at most 2 confirmations per network per day", async () => {
    const f = stubFetch();
    const e = testEnv(mocks(), { CONFIRM_DAILY_LIMIT: "10" });
    for (const em of ["a@example.com", "b@example.com", "c@example.com"]) await postQuery(e, { query: em, subscribe: true }, { email: em });
    expect(sent(f)).toHaveLength(2);
  });

  it("checks the mail domain before claiming a slot, so undeliverable addresses use none", async () => {
    const f = stubFetch((url) => (url.includes("nowhere-at-all") ? Response.json({ Status: 3 }) : undefined));
    const e = testEnv(mocks()); // CONFIRM_DAILY_LIMIT=2
    await postQuery(e, { query: "bad", subscribe: true }, { email: "x@nowhere-at-all.invalid", ip: "198.51.100.61" });
    await postQuery(e, { query: "good1", subscribe: true }, { email: "g1@example.com", ip: "198.51.100.62" });
    await postQuery(e, { query: "good2", subscribe: true }, { email: "g2@example.com", ip: "198.51.100.63" });
    expect(sent(f).map((c) => (c.body as { email: string }).email)).toEqual(["g1@example.com", "g2@example.com"]);
    // the undeliverable address is remembered: no repeat DNS lookups for it
    const dnsBefore = f.calls.filter((c) => c.url.includes("nowhere-at-all")).length;
    await postQuery(e, { query: "bad again", subscribe: true }, { email: "x@nowhere-at-all.invalid", ip: "198.51.100.61" });
    expect(f.calls.filter((c) => c.url.includes("nowhere-at-all")).length).toBe(dnsBefore);
  });

  it("gives the slot back when Loops refuses the send", async () => {
    let fail = true;
    const f = stubFetch((url) => (url.endsWith("/transactional") && fail ? new Response("no", { status: 500 }) : undefined));
    const e = testEnv(mocks(), { CONFIRM_DAILY_LIMIT: "1" });
    await postQuery(e, { query: "1", subscribe: true }, { email: "a@example.com", ip: "198.51.100.71" });
    fail = false;
    await postQuery(e, { query: "2", subscribe: true }, { email: "b@example.com", ip: "198.51.100.72" });
    expect(sent(f).filter((c) => (c.body as { email: string }).email === "b@example.com")).toHaveLength(1);
  });
});

describe("L3: lead retention", () => {
  it("deletes unconfirmed and undeliverable leads after 60 days, keeps confirmed ones", async () => {
    stubFetch();
    const e = testEnv(mocks());
    await postQuery(e, { query: "warm up" }); // creates the Gate instance
    const old = Date.now() - 61 * 86_400_000;
    const recent = Date.now() - 5 * 86_400_000;
    await sql(e, "INSERT INTO leads (email, state, first_seen, confirm_sent_at) VALUES ('p@x.co','pending',?,?), ('u@x.co','undeliverable',?,NULL), ('c@x.co','confirmed',?,?), ('r@x.co','pending',?,?)", old, old, old, old, old, recent, recent);
    await sql(e, "INSERT INTO lead_use (email, n, days, last_day, last_seen) VALUES ('p@x.co',1,1,'2000-01-01',?), ('r@x.co',1,1,'2000-01-01',?)", old, recent);
    expect(await runDurableObjectAlarm(gateOf(e))).toBe(true);
    const left = (await sql(e, "SELECT email FROM leads ORDER BY email")).map((r) => r.email);
    expect(left).toEqual(["c@x.co", "r@x.co"]);
    expect((await sql(e, "SELECT email FROM lead_use")).map((r) => r.email)).toEqual(["r@x.co"]);
  });
});

describe("M2: no CORS", () => {
  it("sends no Access-Control-Allow-Origin on /query, /mcp, preflight or health", async () => {
    stubFetch();
    const e = testEnv(mocks());
    const responses = [
      await postQuery(e, { query: "q" }),
      await call(e, "/mcp", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }),
      await call(e, "/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }),
      await call(e, "/health"),
    ];
    for (const r of responses) expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("L1: /health/deep", () => {
  it("is rate limited per network", async () => {
    stubFetch();
    await seedDocs([{ id: "s1", vertical: "sales", title: "t", summary: "s", source_url: "https://www.close.com/blog/x" }]);
    const m = mocks();
    const e = testEnv(m, { HEALTH_BURST: fakeLimiter(() => false).limiter });
    const r = await call(e, "/health/deep");
    expect(r.status).toBe(429);
    expect(m.ai.run).not.toHaveBeenCalled();
  });

  it("serves the last result while another caller is refreshing", async () => {
    stubFetch();
    await seedDocs([{ id: "s1", vertical: "sales", title: "t", summary: "s", source_url: "https://www.close.com/blog/x" }]);
    const m = mocks();
    const e = testEnv(m);
    expect((await call(e, "/health/deep")).status).toBe(200);
    expect(m.ai.run).toHaveBeenCalledTimes(1);
    // memo expires while a refresh is already in flight elsewhere
    await sql(e, "DELETE FROM cache WHERE k = 'm:health'");
    await sql(e, "INSERT INTO flags (k, at, exp) VALUES ('refresh:health', ?, ?)", Date.now(), Date.now() + 30_000);
    const r = await call(e, "/health/deep");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, stale: true });
    expect(m.ai.run).toHaveBeenCalledTimes(1);
    // the refresher finishes and releases the claim: the next expiry runs real checks again
    await sql(e, "DELETE FROM flags WHERE k = 'refresh:health'");
    await call(e, "/health/deep");
    expect(m.ai.run).toHaveBeenCalledTimes(2);
  });
});

describe("L4 and duplicates in output", () => {
  it("returns one result per source page, without inline links, with a real title", async () => {
    stubFetch();
    const url = "https://www.lennysnewsletter.com/p/an-ai-state-of-the-union";
    const m = mocks([
      { score: 0.9, metadata: meta({ vertical: "sales", source_url: url, title: "https://www.lennysnewsletter.com/", summary: "Agents crossed the line. Read more at https://x.example/y." }) },
      { score: 0.89, metadata: meta({ vertical: "content", source_url: `${url}/` }) },
      { score: 0.5, metadata: meta() },
    ]);
    const e = testEnv(m);
    const r = (await (await postQuery(e, { query: "ai agents" })).json()) as { results: Array<{ title: string; summary: string; source_url: string }> };
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ title: "Agents crossed the line", summary: "Agents crossed the line. Read more at" });
  });
});
