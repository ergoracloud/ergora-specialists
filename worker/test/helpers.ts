import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import type { Env } from "../src/config";
import worker from "../src/index";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the Cloudflare.Env test bindings
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      KB_FTS: D1Database;
    }
  }
}

export const OK_URL = "https://www.lennysnewsletter.com/p/how-to-price";

export function meta(over: Record<string, unknown> = {}) {
  return {
    vertical: "sales",
    title: "Pricing your SaaS",
    summary: "Value based pricing beats cost plus for most B2B SaaS products.",
    source_url: OK_URL,
    status: "approved",
    ...over,
  };
}

export interface Mocks {
  ai: { run: ReturnType<typeof vi.fn> };
  kb: { query: ReturnType<typeof vi.fn>; describe: ReturnType<typeof vi.fn> };
}

export function mocks(matches: Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }> = [{ score: 0.71, metadata: meta() }]): Mocks {
  return {
    ai: { run: vi.fn(async () => ({ shape: [1, 384], data: [new Array(384).fill(0.01)], pooling: "cls" })) },
    kb: {
      query: vi.fn(async () => ({ matches: matches.map((m, i) => ({ id: m.id ?? `sales_${i}`, score: m.score ?? 0.5, metadata: m.metadata })), count: matches.length })),
      describe: vi.fn(async () => ({ vectorCount: 8960, dimensions: 384 })),
    },
  };
}

let n = 0;
export function testEnv(m: Mocks, over: Partial<Env> = {}): Env {
  n += 1;
  return { ...(env as unknown as Env), AI: m.ai as unknown as Ai, KB: m.kb as unknown as VectorizeIndex, GATE_NAME: `test-${n}-${Math.random()}`, ...over };
}

export async function migrate(): Promise<void> {
  await applyD1Migrations(env.KB_FTS, env.TEST_MIGRATIONS);
}

export async function seedDocs(rows: Array<{ id: string; vertical: string; title: string; summary: string; source_url: string }>): Promise<void> {
  await env.KB_FTS.exec("DELETE FROM kb_docs");
  for (const r of rows) {
    await env.KB_FTS.prepare(
      "INSERT INTO kb_docs (id, vertical, title, summary, source_url, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, 'h', '2026-10-21')",
    ).bind(r.id, r.vertical, r.title, r.summary, r.source_url).run();
  }
}

export async function call(e: Env, path: string, init: RequestInit & { ip?: string; asn?: number } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "203.0.113.7");
  const ctx = createExecutionContext();
  const { ip: _ip, asn, ...rest } = init;
  void _ip;
  const req = new Request(`https://gw.example.test${path}`, { ...rest, headers, ...(asn ? { cf: { asn } } : {}) } as RequestInit);
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function postQuery(e: Env, body: Record<string, unknown>, opts: { ip?: string; email?: string; asn?: number } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.email) headers["x-ergora-email"] = opts.email;
  return call(e, "/query", { method: "POST", body: JSON.stringify(body), headers, ip: opts.ip, asn: opts.asn });
}

// Waits for a new minute window when the current one is about to end, so a burst test stays in one window.
export async function freshWindow(marginMs = 5_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < marginMs) await new Promise((r) => setTimeout(r, left + 50));
}

// Wraps the Gate namespace so a test can count how many requests reached the Durable Object.
export function countingGate(e: Env) {
  const real = e.GATE_DO;
  let calls = 0;
  const ns = {
    idFromName: (n: string) => real.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = real.get(id);
      return new Proxy(stub, {
        get(target, prop, receiver) {
          if (prop === "admit") return (input: unknown) => { calls += 1; return (target as unknown as { admit: (i: unknown) => unknown }).admit(input); };
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  } as unknown as Env["GATE_DO"];
  return { ns, calls: () => calls };
}

export function gateOf(e: Env) {
  return e.GATE_DO.get(e.GATE_DO.idFromName(e.GATE_NAME || "gate"));
}

export function rpc(e: Env, method: string, params: Record<string, unknown> = {}, opts: { ip?: string } = {}) {
  return call(e, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ip: opts.ip,
  });
}

// Records outbound fetches (uptime hub, Loops, DNS) and answers them locally.
export function stubFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });
    const custom = handler?.(url, init);
    if (custom) return custom;
    if (url.includes("dns-query")) return Response.json({ Status: 0, Answer: [{ data: "mx.example.test" }] });
    return Response.json({ ok: true, ids: [1] });
  });
  return { calls, spy, hub: () => calls.filter((c) => c.url.startsWith("https://hub.example.test/")) };
}
