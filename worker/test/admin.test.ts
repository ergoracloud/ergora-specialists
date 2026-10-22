// POST /admin/alert-test: guarded, undiscoverable, rate limited, and it never echoes the token or the hub URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetIsolateState } from "../src/query";
import { call, mocks, stubFetch, testEnv } from "./helpers";

beforeEach(() => _resetIsolateState());
afterEach(() => vi.restoreAllMocks());

const TOKEN = "a".repeat(20) + "0123456789abcdef0123456789abcdef";
const post = (e: ReturnType<typeof testEnv>, auth?: string, body?: unknown, method = "POST") =>
  call(e, "/admin/alert-test", {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
  });

describe("admin alert test", () => {
  it("answers 404 without a token, with a wrong token, for GET, and when ADMIN_TOKEN is unset", async () => {
    const f = stubFetch();
    const e = testEnv(mocks(), { ADMIN_TOKEN: TOKEN });
    for (const r of [
      await post(e),
      await post(e, "Bearer nope"),
      await post(e, `Bearer ${TOKEN}x`),
      await post(e, TOKEN),
      await post(e, `Bearer ${TOKEN}`, undefined, "GET"),
      await post(testEnv(mocks()), "Bearer "),
    ]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(f.hub()).toHaveLength(0);
  });

  it("sends one labelled test event, returns the hub status only, and allows one a minute", async () => {
    const f = stubFetch();
    const e = testEnv(mocks(), { ADMIN_TOKEN: TOKEN });
    const r = await post(e, `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, hub_status: 200, notify: true });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("hub.example.test");
    const hub = f.hub();
    expect(hub).toHaveLength(1);
    expect(hub[0].url).toBe("https://hub.example.test/v1/events");
    expect(hub[0].body).toMatchObject({
      events: [{ kind: "test", severity: "info", title: "ergora-specialists alert test", notify: true, target: "ergora-specialists" }],
    });
    const again = await post(e, `Bearer ${TOKEN}`);
    expect(again.status).toBe(429);
    expect(f.hub()).toHaveLength(1);
  });

  it("honours notify:false and reports a hub failure as 502 with its status", async () => {
    const f = stubFetch((url) => (url.startsWith("https://hub.example.test/") ? new Response("nope", { status: 401 }) : undefined));
    const e = testEnv(mocks(), { ADMIN_TOKEN: TOKEN });
    const r = await post(e, `Bearer ${TOKEN}`, { notify: false });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, hub_status: 401, notify: false });
    expect(f.hub()[0].body).toMatchObject({ events: [{ notify: false }] });
  });

  it("refuses a short ADMIN_TOKEN even when it matches", async () => {
    stubFetch();
    const e = testEnv(mocks(), { ADMIN_TOKEN: "short" });
    expect((await post(e, "Bearer short")).status).toBe(404);
  });
});

describe("hub delivery", () => {
  it("uses the UPTIME_HUB service binding when it is bound", async () => {
    const f = stubFetch();
    const seen: Array<{ url: string; auth: string | null }> = [];
    const binding = {
      fetch: vi.fn(async (u: string, i: RequestInit) => {
        seen.push({ url: u, auth: new Headers(i.headers).get("authorization") });
        return Response.json({ ok: true, ids: [9] });
      }),
    } as unknown as Fetcher;
    const e = testEnv(mocks(), { ADMIN_TOKEN: TOKEN, UPTIME_HUB: binding });
    const r = await post(e, `Bearer ${TOKEN}`);
    expect(await r.json()).toMatchObject({ ok: true, hub_status: 200 });
    expect(seen).toEqual([{ url: "https://hub.example.test/v1/events", auth: "Bearer test-hub-token" }]);
    expect(f.hub()).toHaveLength(0);
  });
});
