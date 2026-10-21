// Public error codes. Callers only ever see these fixed codes and messages; the real cause is logged with
// console.error and (for upstream failures) sent to the uptime hub. No upstream status, URL or binding name leaks.
import { attributionUrl, num, type Env } from "./config";

export type PublicCode =
  | "BAD_REQUEST"
  | "UNKNOWN_VERTICAL"
  | "REQUEST_TOO_LARGE"
  | "RATE_LIMITED"
  | "DAILY_LIMIT_REACHED"
  | "TOO_MANY_EMAILS"
  | "SERVICE_DAILY_LIMIT"
  | "UPSTREAM_UNAVAILABLE"
  | "NOT_FOUND"
  | "INTERNAL";

export const STATUS: Record<PublicCode, number> = {
  BAD_REQUEST: 400,
  UNKNOWN_VERTICAL: 400,
  REQUEST_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  DAILY_LIMIT_REACHED: 429,
  TOO_MANY_EMAILS: 429,
  SERVICE_DAILY_LIMIT: 429,
  UPSTREAM_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export interface PublicError {
  error: string; // human message (kept as `error` so v0.3 clients still print it)
  code: PublicCode;
  upgrade?: string;
}

export const upgradeLine = (env: Env) =>
  `Ergora runs all 17 of these specialists as full AI agents with unlimited use: ${attributionUrl(env)}`;

export function publicError(env: Env, code: PublicCode, extra: { limit?: number; kind?: string } = {}): PublicError {
  const url = attributionUrl(env);
  switch (code) {
    case "SERVICE_DAILY_LIMIT":
      return {
        code,
        error: `Ergora Specialists has reached today's free limit for everyone. Please try again tomorrow (it resets at 00:00 UTC), or use the full specialists in Ergora: ${url}`,
      };
    case "DAILY_LIMIT_REACHED": {
      const anon = extra.kind === "ip" || extra.kind === "pool";
      const hint = anon
        ? ` Add an email to unlock ${num(env, "DAILY_LIMIT", 30)} free queries a day (X-Ergora-Email header, ERGORA_EMAIL, or the \`email\` tool argument).`
        : "";
      const scope =
        extra.kind === "email"
          ? "your free daily limit"
          : extra.kind === "unconfirmed"
            ? "the free daily limit for unconfirmed emails on this network"
            : "the free daily limit for this network";
      const count = extra.limit ? ` (${extra.limit} queries)` : "";
      return { code, error: `You have reached ${scope}${count}. Please try again tomorrow.${hint}`, upgrade: upgradeLine(env) };
    }
    case "TOO_MANY_EMAILS":
      return {
        code,
        error: `Too many different emails have been used from this network today (the limit is ${extra.limit ?? 3}). Please keep using the same email, or try again tomorrow.`,
        upgrade: upgradeLine(env),
      };
    case "RATE_LIMITED":
      return { code, error: "Too many requests in a short time. Please slow down (about 30 a minute is the ceiling) and try again." };
    case "UPSTREAM_UNAVAILABLE":
      return { code, error: `The knowledge base is temporarily unavailable. Please try again in a few minutes, or use Ergora: ${url}` };
    case "UNKNOWN_VERTICAL":
      return { code, error: "Unknown vertical. Call ergora_list_specialists (or GET /verticals) for the valid slugs." };
    case "REQUEST_TOO_LARGE":
      return { code, error: "Request too large." };
    case "BAD_REQUEST":
      return { code, error: "A non-empty `query` string is required." };
    case "NOT_FOUND":
      return { code, error: "Not found." };
    default:
      return { code: "INTERNAL", error: "Internal error. Please try again." };
  }
}
