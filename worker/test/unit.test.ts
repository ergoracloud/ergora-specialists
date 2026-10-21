import { describe, expect, it } from "vitest";
import { SPECIALISTS, type Env } from "../src/config";
import { identify, inCidr, networkKey } from "../src/net";
import { gateResult, isAllowedSource } from "../src/policy";
import { ftsExpression, normaliseQuery } from "../src/search";
import { mcpTools } from "../src/mcp";
import cases from "../../shared/policy_cases.json";
import { meta } from "./helpers";

describe("source policy", () => {
  it("accepts allowlisted https hosts, with or without www", () => {
    expect(isAllowedSource("https://www.lennysnewsletter.com/p/x")).toBe(true);
    expect(isAllowedSource("https://lennysnewsletter.com/p/x")).toBe(true);
  });
  it("rejects non-https, credentials, ports and script URLs", () => {
    expect(isAllowedSource("http://lennysnewsletter.com/p/x")).toBe(false);
    expect(isAllowedSource("javascript:alert(1)")).toBe(false);
    expect(isAllowedSource("data:text/html,hi")).toBe(false);
    expect(isAllowedSource("https://user:pw@lennysnewsletter.com/")).toBe(false);
    expect(isAllowedSource("https://lennysnewsletter.com:8443/")).toBe(false);
    expect(isAllowedSource(42)).toBe(false);
  });
  it("rejects excluded hosts and their subdomains, and unknown hosts", () => {
    expect(isAllowedSource("https://hbr.org/2020/01/x")).toBe(false);
    expect(isAllowedSource("https://github.com/a/b")).toBe(false);
    expect(isAllowedSource("https://someone.github.io/x")).toBe(false);
    expect(isAllowedSource("https://raw.githubusercontent.com/a")).toBe(false);
    expect(isAllowedSource("https://evil.example.com/")).toBe(false);
    // no wildcard subdomains: a listed apex does not admit arbitrary subdomains
    expect(isAllowedSource("https://attacker.wordpress.com/")).toBe(false);
  });
  it("agrees with the shared parity cases (same file the Python sync tests use)", () => {
    for (const [url, expected] of cases.cases as Array<[string, boolean]>) expect([url, isAllowedSource(url)]).toEqual([url, expected]);
  });
  it("gates on status, vertical and empty summaries", () => {
    expect(gateResult(meta(), 0.5, "sales", true)).not.toBeNull();
    expect(gateResult(meta({ status: "draft" }), 0.5, undefined, true)).toBeNull();
    expect(gateResult(meta({ status: undefined }), 0.5, undefined, true)).toBeNull();
    expect(gateResult(meta(), 0.5, "finance", true)).toBeNull();
    expect(gateResult(meta({ summary: "  " }), 0.5, undefined, true)).toBeNull();
    expect(gateResult(meta({ source_url: "https://hbr.org/x" }), 0.5, undefined, true)).toBeNull();
    expect(gateResult(meta({ status: undefined }), null, undefined, false)?.score).toBeNull();
  });
});

describe("caller identity", () => {
  const env = { POOLED_CIDRS: '["160.79.104.0/21"]', ANON_LIMIT: "5", DAILY_LIMIT: "30", IP_DAILY_LIMIT: "200", POOL_ANON_LIMIT: "250", POOL_IP_DAILY_LIMIT: "1000" } as unknown as Env;
  it("matches IPv4 CIDRs", () => {
    expect(inCidr("160.79.104.1", "160.79.104.0/21")).toBe(true);
    expect(inCidr("160.79.111.255", "160.79.104.0/21")).toBe(true);
    expect(inCidr("160.79.112.0", "160.79.104.0/21")).toBe(false);
    expect(inCidr("not-an-ip", "160.79.104.0/21")).toBe(false);
  });
  it("pools hosted-client egress and keys IPv6 by /64", () => {
    expect(identify(env, "", "160.79.105.3")).toMatchObject({ kind: "pool", netKey: "pool:160.79.104.0/21", netLimit: 250 });
    expect(identify(env, "A@B.co", "160.79.105.3")).toMatchObject({ kind: "email", emailKey: "a@b.co", netLimit: 1000 });
    expect(identify(env, "", "198.51.100.4")).toMatchObject({ kind: "ip", netLimit: 5 });
    expect(identify(env, "not-an-email", "198.51.100.4").kind).toBe("ip");
    expect(networkKey("2001:db8:1:2:aaaa::1")).toBe(networkKey("2001:db8:1:2:bbbb::9"));
    expect(networkKey("2001:db8:1:2::1")).not.toBe(networkKey("2001:db8:1:3::1"));
  });
});

describe("keyword expression", () => {
  it("keeps only safe tokens and scopes to the vertical", () => {
    const e = ftsExpression('How do I "price" a SaaS) OR NEAR(* product?', "sales");
    expect(e).toBe('vertical : "sales" AND {title summary} : ("price" OR "saas" OR "near" OR "product")');
    expect(ftsExpression("the a of", undefined)).toBeNull();
  });
  it("normalises queries for the cache key", () => {
    expect(normaliseQuery("  Pricing   SaaS?? ")).toBe("pricing saas");
  });
});

describe("tool listing", () => {
  it("lists 19 read-only tools with titles and no em or en dashes", () => {
    const tools = mcpTools();
    expect(tools).toHaveLength(Object.keys(SPECIALISTS).length + 2);
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(`${t.title} ${t.description}`).not.toMatch(/[–—]/);
      expect(t.name.length).toBeLessThan(64);
    }
  });
});
