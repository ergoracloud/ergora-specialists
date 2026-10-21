// Caller identity and the limits that apply to it. The Gate DO decides; this module only works out keys and limits.
//
// Non-pooled callers (one IP, IPv6 keyed by /64):
//  - anonymous: ANON_LIMIT/day per network
//  - with an email that is NOT confirmed: DAILY_LIMIT/day per email, at most MAX_EMAILS_PER_NET distinct emails per
//    network per day, and the network's whole unconfirmed traffic (anonymous + unconfirmed emails) is capped at
//    NET_UNCONFIRMED_LIMIT. Unconfirmed traffic is also capped per IPv6 /48 (V6_48_LIMIT) and per ASN (ASN_LIMIT),
//    so rotating /64s or hopping inside one provider does not multiply the allowance.
//  - with a confirmed email (double opt-in done): DAILY_LIMIT/day per email; the network ceiling IP_DAILY_LIMIT
//    applies, and the /48, ASN and distinct-email caps do not.
// Pooled callers (a hosted AI client's shared egress, e.g. Claude's 160.79.104.0/21): thousands of users share those
// IPs, so the pool has its own allowances: POOL_ANON_LIMIT anonymous, POOL_UNCONFIRMED_EMAIL_LIMIT per unconfirmed
// email, POOL_UNCONFIRMED_LIMIT for all unconfirmed traffic, POOL_IP_DAILY_LIMIT in total.
// Part of the global cap (GLOBAL_RESERVE_PCT) is reserved for confirmed emails and the pool.
import { LIMITS, num, type Env } from "./config";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

export interface Caller {
  kind: "email" | "ip" | "pool";
  /** normalised mailbox, used for every count and the lead row */
  emailKey?: string;
  /** the address as given (lowercased, trimmed), used only to send a confirmation email */
  emailAddr?: string;
  netKey: string;
  /** edge burst limiter and per-network confirmation limits: the network, or pool + raw IP */
  burstKey: string;
  pooled: boolean;
  /** anonymous allowance for this network */
  anonLimit: number;
  /** network ceiling (everything) */
  netLimit: number;
  /** network ceiling for unconfirmed traffic (anonymous + unconfirmed emails) */
  unconfirmedNetLimit: number;
  /** per email, confirmed / unconfirmed */
  emailLimit: number;
  unconfirmedEmailLimit: number;
  /** distinct emails per network per day; 0 = no cap (pool) */
  maxEmailsPerNet: number;
  /** extra counters for unconfirmed traffic: IPv6 /48 and ASN */
  secondary: Array<{ key: string; limit: number }>;
}

export function parseEmail(raw: unknown): string | null {
  const e = raw == null ? "" : String(raw).trim().toLowerCase();
  return e && e.length <= LIMITS.MAX_EMAIL && EMAIL_RE.test(e) ? e : null;
}

// One key per mailbox: lowercase, no +tag, and Gmail ignores dots (googlemail.com is the same mailbox).
export function normaliseEmail(email: string): string {
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1).replace(/\.$/, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = parseInt(bitsRaw ?? "32", 10);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base ?? "");
  if (a == null || b == null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function pooledCidrs(env: Env): string[] {
  try {
    const v = JSON.parse(env.POOLED_CIDRS || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Full 8-hextet expansion of an IPv6 address (null if it is not one).
export function expandV6(ip: string): string[] | null {
  if (!ip.includes(":")) return null;
  const addr = ip.split("%")[0].toLowerCase();
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // an embedded IPv4 tail (::ffff:1.2.3.4) counts as two hextets
  const fix = (xs: string[]) => xs.flatMap((h) => (h.includes(".") ? ["0", "0"] : [h]));
  const h = fix(head);
  const t = fix(tail);
  const fill = halves.length === 2 ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const all = [...h, ...new Array(fill).fill("0"), ...t];
  if (all.length !== 8 || all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => x.replace(/^0+(?=.)/, ""));
}

export function networkKey(ip: string): string {
  if (!ip) return "unknown";
  const v6 = expandV6(ip);
  if (v6) return `v6:${v6.slice(0, 4).join(":")}::/64`;
  return `v4:${ip}`;
}

export function v6Prefix48(ip: string): string | null {
  const v6 = expandV6(ip);
  return v6 ? `v6:${v6.slice(0, 3).join(":")}::/48` : null;
}

export function identify(env: Env, rawEmail: unknown, ip: string, asn?: number | null): Caller {
  const emailLimit = num(env, "DAILY_LIMIT", 30);
  const pool = pooledCidrs(env).find((c) => inCidr(ip, c));
  const addr = parseEmail(rawEmail);
  const email = addr ? { emailKey: normaliseEmail(addr), emailAddr: addr } : {};
  if (pool) {
    const netKey = `pool:${pool}`;
    return {
      kind: addr ? "email" : "pool",
      ...email,
      netKey,
      burstKey: `${netKey}|${ip}`,
      pooled: true,
      anonLimit: num(env, "POOL_ANON_LIMIT", 60),
      netLimit: num(env, "POOL_IP_DAILY_LIMIT", 1000),
      unconfirmedNetLimit: num(env, "POOL_UNCONFIRMED_LIMIT", 600),
      emailLimit,
      unconfirmedEmailLimit: num(env, "POOL_UNCONFIRMED_EMAIL_LIMIT", 10),
      maxEmailsPerNet: 0,
      secondary: [],
    };
  }
  const netKey = networkKey(ip);
  const secondary: Caller["secondary"] = [];
  const p48 = v6Prefix48(ip);
  if (p48) secondary.push({ key: p48, limit: num(env, "V6_48_LIMIT", 300) });
  if (typeof asn === "number" && Number.isFinite(asn) && asn > 0) secondary.push({ key: `asn:${asn}`, limit: num(env, "ASN_LIMIT", 1000) });
  return {
    kind: addr ? "email" : "ip",
    ...email,
    netKey,
    burstKey: netKey,
    pooled: false,
    anonLimit: num(env, "ANON_LIMIT", 5),
    netLimit: num(env, "IP_DAILY_LIMIT", 200),
    unconfirmedNetLimit: num(env, "NET_UNCONFIRMED_LIMIT", 50),
    emailLimit,
    unconfirmedEmailLimit: emailLimit,
    maxEmailsPerNet: num(env, "MAX_EMAILS_PER_NET", 3),
    secondary,
  };
}
