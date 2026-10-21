// Double opt-in before anything reaches Loops.
// 1. Only after real use: the Gate marks an email eligible after 3 queries across 2 UTC days, or when the caller
//    explicitly asks (the `subscribe` argument). Then the MX/A check runs FIRST (undeliverable addresses are
//    remembered for 30 days and never use a slot), then the Gate claims a slot (once per address per 30 days,
//    CONFIRM_DAILY_LIMIT a day overall, CONFIRM_NET_DAILY_LIMIT a day per network) -> Loops transactional
//    "confirm your address" email.
// 2. The link opens GET /confirm (a page with a button, so mail scanners that prefetch links confirm nothing).
// 3. POST /confirm -> the Gate marks the lead confirmed (single-use token) -> Loops contact created (mcp-lead).
// The link carries only a random token; the email address never appears in a URL.
import { num, type Env } from "./config";
import type { Gate } from "./gate";

const TOKEN_TTL_SEC = 7 * 86400;

const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export function confirmationConfigured(env: Env): boolean {
  return Boolean(env.LOOPS_API_KEY && env.LOOPS_CONFIRM_TEMPLATE_ID);
}

export async function hasMailDomain(domain: string): Promise<boolean> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return false;
  try {
    for (const type of ["MX", "A"]) {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(3000),
      });
      const d = (await r.json()) as { Status?: number; Answer?: unknown[] };
      if (d.Status === 0 && Array.isArray(d.Answer) && d.Answer.length) return true;
    }
  } catch {
    /* lookup failure = not deliverable */
  }
  return false;
}

export interface ConfirmTarget {
  email: string; // normalised mailbox (lead key)
  addr: string; // address as given, where the email is sent
  netKey: string; // network (or pool + IP) for the per-network daily limit
}

// Call only when the Gate said the address is eligible (AdmitResult.confirmEligible).
export async function startConfirmation(
  env: Env, gate: DurableObjectStub<Gate>, who: ConfirmTarget, vertical: string, base: string, now = Date.now(),
): Promise<void> {
  if (!confirmationConfigured(env)) return; // nothing is stored until Loops is set up
  if (!(await hasMailDomain(who.addr.split("@")[1] || ""))) {
    await gate.markUndeliverable(who.email, now);
    return;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = hex(bytes);
  const tokenHash = await sha256Hex(token);
  const claimed = await gate.claimConfirmation({
    email: who.email,
    addr: who.addr,
    vertical,
    now,
    dailyLimit: num(env, "CONFIRM_DAILY_LIMIT", 100),
    netKey: who.netKey,
    netDailyLimit: num(env, "CONFIRM_NET_DAILY_LIMIT", 2),
    tokenHash,
    tokenTtlSec: TOKEN_TTL_SEC,
  });
  if (!claimed) return;
  try {
    const res = await fetch("https://app.loops.so/api/v1/transactional", {
      method: "POST",
      headers: { authorization: `Bearer ${env.LOOPS_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        transactionalId: env.LOOPS_CONFIRM_TEMPLATE_ID,
        email: who.addr,
        dataVariables: { confirmUrl: `${base}/confirm?t=${token}` },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`loops transactional ${res.status}`);
  } catch (e) {
    console.error("confirmation email not sent:", (e as Error)?.message);
    await gate.releaseClaim(who.email, tokenHash, who.netKey, now);
  }
}

async function createLoopsContact(env: Env, email: string, vertical: string): Promise<boolean> {
  if (!env.LOOPS_API_KEY) return false;
  try {
    const res = await fetch("https://app.loops.so/api/v1/contacts/create", {
      method: "POST",
      headers: { authorization: `Bearer ${env.LOOPS_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ email, source: "ergora-specialists-mcp", userGroup: "mcp-lead", firstVertical: vertical, subscribed: true }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok || res.status === 409; // 409 = already a contact
  } catch {
    return false;
  }
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${title}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#111;background:#fff}` +
      `button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#111;color:#fff;cursor:pointer}</style>` +
      `</head><body><h1>${title}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "x-robots-tag": "noindex",
      },
    },
  );

const TOKEN_RE = /^[0-9a-f]{64}$/;

export async function handleConfirm(request: Request, env: Env, gate: DurableObjectStub<Gate>): Promise<Response> {
  if (request.method === "GET") {
    const t = new URL(request.url).searchParams.get("t") || "";
    if (!TOKEN_RE.test(t)) return page("Link not valid", "<p>This confirmation link is not valid.</p>", 400);
    return page(
      "Confirm your email",
      `<p>Confirm that you want occasional Ergora updates at this address. You can unsubscribe at any time.</p>` +
        `<form method="post" action="/confirm"><input type="hidden" name="t" value="${t}"><button type="submit">Confirm my email</button></form>`,
    );
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  let t = "";
  try {
    t = String((await request.formData()).get("t") || "");
  } catch {
    /* fall through */
  }
  if (!TOKEN_RE.test(t)) return page("Link not valid", "<p>This confirmation link is not valid.</p>", 400);
  const tokenHash = await sha256Hex(t);
  const lead = await gate.confirm(tokenHash, Date.now());
  if (!lead) return page("Link expired", "<p>This link has expired or was already used.</p>", 410);
  if (!(await createLoopsContact(env, lead.addr, lead.firstVertical))) {
    await gate.unconfirm(lead.email, tokenHash, Date.now());
    return page("Please try again", "<p>We could not save that just now. Please use the same link again in a minute.</p>", 503);
  }
  return page("Thanks, you are confirmed", "<p>Your email is confirmed. You can close this page.</p>");
}
