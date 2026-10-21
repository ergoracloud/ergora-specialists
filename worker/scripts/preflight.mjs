// Refuses a deploy that would break the v2 contract. Run by `npm run deploy` (and `npm run check`).
//  - D1 database_id must be a real id (filled in after `wrangler d1 create ergora-kb-fts`)
//  - Vectorize binding must point at ergora-kb-v2 (384d); the old Gemini index is not compatible
//  - [[ratelimits]] must come after the whole [vars] block (otherwise later vars are swallowed)
//  - no GCP/Vertex settings may come back
import { readFileSync } from "node:fs";

const configOnly = process.argv.includes("--config-only");
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const errors = [];

const dbId = /database_id\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
if (!configOnly && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(dbId) || /^0{8}-/.test(dbId)))
  errors.push("wrangler.toml: set [[d1_databases]] database_id to the id printed by `wrangler d1 create ergora-kb-fts` (RUNBOOK step 4)");
if (!/index_name\s*=\s*"ergora-kb-v2"/.test(toml)) errors.push("wrangler.toml: [[vectorize]] index_name must be ergora-kb-v2");
const varsAt = toml.indexOf("\n[vars]");
const rlAt = toml.indexOf("\n[[ratelimits]]");
if (varsAt < 0 || rlAt < 0 || rlAt < varsAt) errors.push("wrangler.toml: [[ratelimits]] must come after the [vars] block");
if (/^\s*GCP_/m.test(toml)) errors.push("wrangler.toml: GCP_* vars are gone in v2; remove them");
if (!/GLOBAL_DAILY_LIMIT\s*=\s*"\d+"/.test(toml)) errors.push("wrangler.toml: GLOBAL_DAILY_LIMIT missing");

if (errors.length) {
  console.error("preflight FAILED:\n - " + errors.join("\n - "));
  process.exit(1);
}
console.log(`preflight ok${configOnly ? " (config only; D1 id not checked)" : ""}`);
