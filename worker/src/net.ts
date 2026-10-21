// Caller identity for quotas.
//  - email: the free tier (DAILY_LIMIT/day), still capped per network (IP_DAILY_LIMIT) so one host can't rotate emails
//  - ip: anonymous (ANON_LIMIT/day). IPv6 is keyed by /64, since one machine usually owns a whole /64
//  - pool: a hosted AI client's shared egress range (e.g. Claude's 160.79.104.0/21). Thousands of users share
//    those IPs, so the pool gets its own larger allowance (POOL_ANON_LIMIT / POOL_IP_DAILY_LIMIT)
import { LIMITS, num, type Env } from "./config";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Caller {
  kind: "email" | "ip" | "pool";
  emailKey?: string;
  netKey: string;
  netLimit: number;
  emailLimit: number;
}

export function parseEmail(raw: unknown): string | null {
  const e = raw == null ? "" : String(raw).trim().toLowerCase();
  return e && e.length <= LIMITS.MAX_EMAIL && EMAIL_RE.test(e) ? e : null;
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

export function networkKey(ip: string): string {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    // Expand enough of the address to take the first four hextets (/64).
    const [head] = ip.split("::");
    const hextets = (head ?? "").split(":").filter(Boolean);
    const full = ip.includes("::") ? [...hextets, "0", "0", "0", "0"].slice(0, 4) : ip.split(":").slice(0, 4);
    return `v6:${full.map((h) => h.toLowerCase()).join(":")}::/64`;
  }
  return `v4:${ip}`;
}

export function identify(env: Env, rawEmail: unknown, ip: string): Caller {
  const emailLimit = num(env, "DAILY_LIMIT", 30);
  const pool = pooledCidrs(env).find((c) => inCidr(ip, c));
  const email = parseEmail(rawEmail);
  if (pool) {
    return email
      ? { kind: "email", emailKey: email, netKey: `pool:${pool}`, netLimit: num(env, "POOL_IP_DAILY_LIMIT", 1000), emailLimit }
      : { kind: "pool", netKey: `pool:${pool}`, netLimit: num(env, "POOL_ANON_LIMIT", 250), emailLimit };
  }
  const netKey = networkKey(ip);
  return email
    ? { kind: "email", emailKey: email, netKey, netLimit: num(env, "IP_DAILY_LIMIT", 200), emailLimit }
    : { kind: "ip", netKey, netLimit: num(env, "ANON_LIMIT", 5), emailLimit };
}
