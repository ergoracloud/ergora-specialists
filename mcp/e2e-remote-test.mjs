// End-to-end test of the REMOTE MCP endpoint (Streamable HTTP) using the official SDK client —
// the same transport Claude Code / Claude Desktop / Cursor use.
//   node e2e-remote-test.mjs                      # anonymous (per-IP quota)
//   ERGORA_EMAIL=you@x.com node e2e-remote-test.mjs   # email tier (via X-Ergora-Email header)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.ERGORA_MCP_URL || "https://ergora-specialists-gateway.contact-c9e.workers.dev/mcp");
const headers = process.env.ERGORA_EMAIL ? { "X-Ergora-Email": process.env.ERGORA_EMAIL } : {};

const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
const client = new Client({ name: "ergora-e2e", version: "0.0.1" });

const t0 = Date.now();
await client.connect(transport);
const info = client.getServerVersion();
console.log(`connected: ${info?.name} v${info?.version} (${Date.now() - t0}ms) protocol=${transport.protocolVersion}`);

const { tools } = await client.listTools();
console.log(`tools: ${tools.length} -> ${tools.slice(0, 3).map(t => t.name).join(", ")} …`);
if (tools.length !== 19) throw new Error(`expected 19 tools, got ${tools.length}`);

const list = await client.callTool({ name: "ergora_list_specialists", arguments: {} });
console.log(`list_specialists: ${list.content[0].text.split("\n").length} lines`);

const t1 = Date.now();
const r = await client.callTool({ name: "ergora_ecommerce", arguments: { query: "how do I reduce cart abandonment on a Shopify store", top_k: 3 } });
console.log(`ergora_ecommerce (${Date.now() - t1}ms) isError=${!!r.isError}:\n${r.content[0].text}\n`);
if (r.isError) throw new Error("tool call returned isError");
if (!/ergora\.app/.test(r.content[0].text)) throw new Error("attribution missing");

const t2 = Date.now();
const x = await client.callTool({ name: "ergora_ask", arguments: { query: "pricing strategy for a SaaS startup", top_k: 3 } });
console.log(`ergora_ask (${Date.now() - t2}ms) isError=${!!x.isError}:\n${x.content[0].text}\n`);
if (x.isError) throw new Error("ergora_ask returned isError");

await client.close();
console.log("REMOTE E2E PASS");
