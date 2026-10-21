import { describe, expect, it } from "vitest";
import { SPECIALISTS, type Env } from "../src/config";
import { identify, inCidr, networkKey, normaliseEmail, v6Prefix48 } from "../src/net";
import { gateResult, isAllowedSource, publicTitle, stripLinks } from "../src/policy";
import { ftsExpression, normaliseQuery } from "../src/search";
import { mcpTools } from "../src/mcp";
import cases from "../../shared/policy_cases.json";
import textCases from "../../shared/text_cases.json";
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
    expect(identify(env, "", "160.79.105.3")).toMatchObject({ kind: "pool", netKey: "pool:160.79.104.0/21", anonLimit: 250, pooled: true });
    expect(identify(env, "A@B.co", "160.79.105.3")).toMatchObject({ kind: "email", emailKey: "a@b.co", netLimit: 1000, maxEmailsPerNet: 0 });
    expect(identify(env, "", "198.51.100.4")).toMatchObject({ kind: "ip", anonLimit: 5, netLimit: 200 });
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

describe("text hygiene (L4)", () => {
  it("strips URLs and markdown links (shared parity cases)", () => {
    for (const [input, expected] of textCases.strip as Array<[string, string]>) expect([input, stripLinks(input)]).toEqual([input, expected]);
  });
  it("derives a title from the summary when the title is a bare URL (shared parity cases)", () => {
    for (const [title, summary, expected] of textCases.titles as Array<[string, string, string]>)
      expect([title, publicTitle(title, summary)]).toEqual([title, expected]);
  });
  it("cuts long derived titles at a word boundary", () => {
    const t = publicTitle("https://x.example/blog", `${"word ".repeat(60)}end.`);
    expect(t.length).toBeLessThanOrEqual(123);
    expect(t.endsWith("...")).toBe(true);
    expect(t).not.toMatch(/wor\.\.\.$/);
  });
  it("gateResult never returns a URL other than source_url", () => {
    const g = gateResult(meta({ title: "https://www.lennysnewsletter.com/", summary: "Price on value. See [this](https://evil.example.com/x) and https://evil.example.com/y now." }), 0.5, undefined, true)!;
    expect(g.title).toBe("Price on value");
    expect(g.summary).toBe("Price on value. See this and now.");
    expect(`${g.title} ${g.summary}`).not.toMatch(/https?:|www\./);
  });
});

describe("email normalisation and network keys (H1, H3)", () => {
  it("maps +tags, case and gmail dots to one mailbox", () => {
    expect(normaliseEmail("john.doe+mcp@googlemail.com")).toBe("johndoe@gmail.com");
    expect(normaliseEmail("j.o.h.n.d.o.e@gmail.com")).toBe("johndoe@gmail.com");
    expect(normaliseEmail("first.last+x@company.com")).toBe("first.last@company.com");
    const env = { DAILY_LIMIT: "30" } as unknown as Env;
    const c = identify(env, " John.Doe+Tag@GMail.com ", "198.51.100.4");
    expect(c).toMatchObject({ emailKey: "johndoe@gmail.com", emailAddr: "john.doe+tag@gmail.com" });
  });
  it("expands IPv6 fully and derives /64 and /48 keys", () => {
    expect(networkKey("2001:0db8:0001:0002::1")).toBe("v6:2001:db8:1:2::/64");
    expect(networkKey("2001:db8::1")).toBe("v6:2001:db8:0:0::/64");
    expect(v6Prefix48("2001:db8:1:2:aaaa::1")).toBe(v6Prefix48("2001:db8:1:ffff::9"));
    expect(v6Prefix48("2001:db8:2::1")).not.toBe(v6Prefix48("2001:db8:1::1"));
    expect(v6Prefix48("198.51.100.4")).toBeNull();
  });
  it("adds /48 and ASN counters for non-pooled callers only", () => {
    const env = { POOLED_CIDRS: '["160.79.104.0/21"]' } as unknown as Env;
    expect(identify(env, "", "2001:db8:1:2::1", 13335).secondary.map((s) => s.key)).toEqual(["v6:2001:db8:1::/48", "asn:13335"]);
    expect(identify(env, "", "198.51.100.4", 64500).secondary).toEqual([{ key: "asn:64500", limit: 1000 }]);
    expect(identify(env, "", "160.79.105.3", 399358).secondary).toEqual([]);
    expect(identify(env, "", "160.79.105.3").burstKey).toBe("pool:160.79.104.0/21|160.79.105.3");
  });
});
