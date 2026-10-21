// Query-time visibility gate. The sync job only loads approved rows from allowlisted hosts, and the
// Worker checks again here, so a stale or poisoned vector can never reach a caller.
import policy from "../../shared/source_policy.json";

const ALLOWED = new Set<string>(policy.hosts.map((h: string) => h.toLowerCase()));
const EXCLUDED: string[] = policy.excluded.map((h: string) => h.toLowerCase());

export const APPROVED_STATUS = "approved";

export function normaliseHost(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}

function isExcluded(host: string): boolean {
  return EXCLUDED.some((d) => host === d || host.endsWith(`.${d}`));
}

// https only, no credentials or odd ports, host on the allowlist and not excluded.
export function isAllowedSource(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 400) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = normaliseHost(u.hostname);
  if (isExcluded(host)) return false;
  return ALLOWED.has(host);
}

export interface PublicResult {
  title: string;
  summary: string;
  source_url: string;
  vertical: string;
  score: number | null;
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

// Text hygiene, mirrored in sync/kb_v2_sync.py (parity cases: shared/text_cases.json). Results carry exactly one
// link, source_url, which passed the allowlist; any other URL inside a title or summary is removed, and markdown
// links keep only their text.
const MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const ANGLE_URL = /<(?:https?:\/\/|www\.)[^>\s]*>/gi;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi;

export function stripLinks(text: string): string {
  return text
    .replace(MD_IMAGE, "$1")
    .replace(MD_LINK, "$1")
    .replace(ANGLE_URL, " ")
    .replace(BARE_URL, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function isBareUrlTitle(title: string): boolean {
  return /^\s*(?:https?:\/\/|www\.)\S*\s*$/i.test(title);
}

// First sentence of the summary, cut at a word boundary, for items whose title is missing or a bare URL.
export function titleFromSummary(summary: string, max = 120): string {
  const s = stripLinks(summary);
  const m = /^(.+?[.!?])(?:\s|$)/.exec(s);
  let t = (m ? m[1] : s).replace(/[.!?]+$/, "").trim();
  if (t.length > max) {
    const cut = t.slice(0, max + 1);
    const sp = cut.lastIndexOf(" ");
    t = `${(sp > 40 ? cut.slice(0, sp) : t.slice(0, max)).replace(/[\s,;:]+$/, "")}...`;
  }
  return t;
}

export function publicTitle(title: string, summary: string): string {
  const t = isBareUrlTitle(title) ? "" : stripLinks(title);
  return (t || titleFromSummary(summary)).slice(0, 200);
}

// Turns raw metadata (Vectorize or D1) into a public result, or null if it fails the gate.
export function gateResult(
  meta: Record<string, unknown> | undefined | null,
  score: number | null,
  wantVertical: string | undefined,
  requireStatus: boolean,
): PublicResult | null {
  if (!meta) return null;
  if (requireStatus && meta.status !== APPROVED_STATUS) return null;
  const vertical = clean(meta.vertical, 40);
  if (wantVertical && vertical !== wantVertical) return null;
  const source_url = clean(meta.source_url, 400);
  if (!isAllowedSource(source_url)) return null;
  const summary = stripLinks(clean(meta.summary, 1200));
  if (!summary) return null;
  return {
    title: publicTitle(clean(meta.title, 200), summary),
    summary,
    source_url,
    vertical,
    score: score == null ? null : Math.round(score * 1000) / 1000,
  };
}
