// Alerts go through the existing outage channel: the uptime-hub Worker (POST /v1/events), which stores the
// event, shows it on tomosborne.me/admin/alerts and sends it to Tom's Telegram when notify is true.
// Delivery uses the UPTIME_HUB service binding: a plain fetch() from one workers.dev Worker to another on the same
// account is refused by Cloudflare (error 1042, seen as HTTP 404), which is why no alert reached the hub before 0.4.3.
// Plain fetch() stays as the fallback for a hub on another account or a custom domain (and for the tests).
// The Gate DO decides "at most once per day per threshold"; the hub's dedupe_key is a second guard.
import { num, type Env } from "./config";
import type { AlertKind, Gate } from "./gate";
import { utcDay, utcMonth } from "./gate";

const DEFAULT_HUB = "https://uptime-hub.contact-c9e.workers.dev";

export interface HubEvent {
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  notify: boolean;
  dedupe_key: string;
  dedupe_window_sec: number;
}

// Posts one event to the hub. Returns the hub's HTTP status, 0 when it was unreachable, or null when no token is set.
export async function sendHub(env: Env, ev: HubEvent): Promise<number | null> {
  if (!env.UPTIME_HUB_TOKEN) {
    console.warn("alert not sent (UPTIME_HUB_TOKEN unset):", ev.kind, ev.title);
    return null;
  }
  const url = `${(env.UPTIME_HUB_URL || DEFAULT_HUB).replace(/\/+$/, "")}/v1/events`;
  try {
    const send = env.UPTIME_HUB ? (u: string, i: RequestInit) => env.UPTIME_HUB!.fetch(u, i) : fetch;
    const res = await send(url, {
      method: "POST",
      headers: { authorization: `Bearer ${env.UPTIME_HUB_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [{ ...ev, target: "ergora-specialists" }] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error("uptime hub rejected alert:", res.status);
    return res.status;
  } catch (e) {
    console.error("uptime hub unreachable:", (e as Error)?.name);
    return 0;
  }
}

export async function postHub(env: Env, ev: HubEvent): Promise<boolean> {
  const status = await sendHub(env, ev);
  return status !== null && status >= 200 && status < 300;
}

export function capEvent(env: Env, kind: AlertKind, now: number): HubEvent {
  const cap = num(env, "GLOBAL_DAILY_LIMIT", 2500);
  const pct = num(env, "ALERT_THRESHOLD_PCT", 80);
  const day = utcDay(now);
  const month = utcMonth(now);
  switch (kind) {
    case "cap_warning":
      return {
        kind: "specialists_cap", severity: "warning", notify: true,
        title: `Ergora Specialists MCP at ${pct}% of the daily cap`,
        detail: `${Math.ceil((cap * pct) / 100)} of ${cap} free queries used today (${day} UTC). New queries are refused once the cap is reached, until 00:00 UTC.`,
        dedupe_key: `specialists-cap-warning-${day}`, dedupe_window_sec: 86400,
      };
    case "cap_reached":
      return {
        kind: "specialists_cap", severity: "warning", notify: true,
        title: "Ergora Specialists MCP daily cap reached",
        detail: `All ${cap} free queries for ${day} UTC are used. Callers now get the polite "try again tomorrow" message until 00:00 UTC. Raise GLOBAL_DAILY_LIMIT only after checking the Free plan budgets.`,
        dedupe_key: `specialists-cap-reached-${day}`, dedupe_window_sec: 86400,
      };
    case "vector_budget":
      return {
        kind: "specialists_budget", severity: "warning", notify: true,
        title: "Ergora Specialists MCP: Vectorize monthly budget used",
        detail: `VECTORIZE_MONTHLY_QUERY_BUDGET (${num(env, "VECTORIZE_MONTHLY_QUERY_BUDGET", 66000)}) reached for ${month}. Queries now use the D1 keyword fallback until the month rolls over, so the account stays inside the Vectorize Free 30M queried-dimensions allowance.`,
        dedupe_key: `specialists-vector-budget-${month}`, dedupe_window_sec: 31 * 86400,
      };
    case "keyword_budget":
      return {
        kind: "specialists_budget", severity: "warning", notify: true,
        title: "Ergora Specialists MCP: D1 keyword budget used",
        detail: `D1_DAILY_ROWS_READ_BUDGET reached for ${day} UTC. Keyword fallback answers are paused until 00:00 UTC.`,
        dedupe_key: `specialists-keyword-budget-${day}`, dedupe_window_sec: 86400,
      };
  }
}

// Sends the alerts the Gate raised; re-arms the flag if delivery failed so the next query retries.
export async function deliverAlerts(env: Env, gate: DurableObjectStub<Gate>, kinds: AlertKind[], now: number): Promise<void> {
  for (const kind of kinds) {
    const ok = await postHub(env, capEvent(env, kind, now));
    if (!ok && env.UPTIME_HUB_TOKEN) await gate.unflag(await gate.alertFlagKey(kind, now));
  }
}

// Upstream (Workers AI / Vectorize / D1) failure: at most one Telegram per component every 6 hours.
export async function upstreamAlert(env: Env, gate: DurableObjectStub<Gate>, component: string, mode: string, now: number): Promise<void> {
  const key = `upstream:${component}`;
  if (!(await gate.flag(key, now, 6 * 3600))) return;
  const ok = await postHub(env, {
    kind: "specialists_upstream", severity: "critical", notify: true,
    title: `Ergora Specialists MCP: ${component} failing`,
    detail: `Queries are being answered in ${mode} mode. Check /health/deep and the Worker logs (wrangler tail).`,
    dedupe_key: `specialists-upstream-${component}-${utcDay(now)}`, dedupe_window_sec: 6 * 3600,
  });
  if (!ok && env.UPTIME_HUB_TOKEN) await gate.unflag(key);
}
