// End-to-end: spawn the MCP server over stdio, list tools, call a specialist tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: "node", args: ["index.js"], env: { ...process.env, ERGORA_EMAIL: "mcp-test@ergora.app" } });
const client = new Client({ name: "e2e", version: "0.0.1" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools: ${tools.length} ->`, tools.map(t => t.name).slice(0, 6).join(", "), "...");
const r = await client.callTool({ name: "ergora_sales", arguments: { query: "cold email subject lines that get replies", top_k: 3 } });
console.log("--- ergora_sales result ---\n" + r.content[0].text);
const l = await client.callTool({ name: "ergora_list_specialists", arguments: {} });
console.log("--- list_specialists (first 2 lines) ---\n" + l.content[0].text.split("\n").slice(0, 2).join("\n"));
await client.close();
