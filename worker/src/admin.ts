// POST /admin/alert-test: fires one clearly labelled test event at the uptime hub so the alert path can be verified
// end to end. Guarded by the ADMIN_TOKEN secret (Authorization: Bearer <token>, constant-time compare). A missing or
// wrong token, an unset ADMIN_TOKEN or any other method gets the router's ordinary 404, so the path is not
// discoverable. At most one test per minute (Gate flag; checked only after the token matched, so strangers never
// reach the Durable Object). The response carries the hub's HTTP status only, never the token or the hub URL.
import { sendHub } from "./alerts";
import type { Env } from "./config";
import { gateStub } from "./query";

const TEST_WINDOW_SEC = 60;

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

export async function adminTokenOk(env: Env, request: Request): Promise<boolean> {
  const expected = env.ADMIN_TOKEN || "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") || "");
  const given = m?.[1] ?? "";
  // Hash both sides so the compare is fixed-length and constant-time whatever the input.
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  const same = crypto.subtle.timingSafeEqual(a, b);
  return same && expected.length >= 32 && given.length > 0;
}

/** null = answer 404 (not an admin request the caller may know about) */
export async function handleAlertTest(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || !env.ADMIN_TOKEN) return null;
  if (!(await adminTokenOk(env, request))) return null;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const now = Date.now();
  if (!(await gateStub(env).flag("admin-alert-test", now, TEST_WINDOW_SEC))) {
    return new Response(JSON.stringify({ ok: false, error: "One test alert a minute. Try again shortly." }), {
      status: 429, headers: { ...headers, "retry-after": String(TEST_WINDOW_SEC) },
    });
  }
  let notify = true;
  try {
    const body = (await request.json()) as { notify?: unknown };
    if (body && body.notify === false) notify = false;
  } catch {
    // no body: defaults
  }
  const at = new Date(now).toISOString();
  const status = await sendHub(env, {
    kind: "test",
    severity: "info",
    title: "ergora-specialists alert test",
    detail: `Test event from the ergora-specialists gateway (POST /admin/alert-test) at ${at}. No action needed: this only proves the alert path to uptime-hub works.`,
    notify,
    dedupe_key: `specialists-alert-test-${now}`,
    dedupe_window_sec: TEST_WINDOW_SEC,
  });
  const ok = status !== null && status >= 200 && status < 300;
  return new Response(JSON.stringify({ ok, hub_status: status, notify, sent_at: at }), { status: ok ? 200 : 502, headers });
}
