// Smoke test: runs the Worker in Node against the live upstream sources,
// with a stand-in ASSETS binding that reads files from the webroot.
//   node test/smoke.mjs            (mounted mode, as in CloudRoot)
//   node test/smoke.mjs --offline  (only routes that need no network)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { handleGoals } from "../src/index.js";

const webroot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ASSETS = {
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    try { return new Response(await readFile(path.join(webroot, p))); } catch { return new Response("Not found", { status: 404 }); }
  },
};
const env = { ASSETS, DATA_PREFIX: "/project/goals", MODELS_PREFIX: "/project/models", PROFILE: "veterans" };
const base = "/api/goals";
const offline = process.argv.includes("--offline");
let failures = 0;

async function call(method, route, body) {
  const req = new Request(`http://localhost:3701${base}${route}`, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleGoals(req, env, {}, base);
  const type = res.headers.get("Content-Type") || "";
  const raw = await res.text();
  return { status: res.status, body: type.includes("json") && raw ? JSON.parse(raw) : raw };
}

async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`ok   ${label}${detail ? `: ${detail}` : ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${label}: ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

await check("initialize", async () => {
  const r = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  assert(r.body.result?.protocolVersion === "2025-06-18", JSON.stringify(r.body));
  return r.body.result.serverInfo.title;
});
await check("notification -> 202", async () => {
  const r = await call("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert(r.status === 202, `status ${r.status}`);
});
await check("tools/list", async () => {
  const r = await call("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = r.body.result.tools.map((t) => t.name);
  assert(names.includes("search_services") && names.includes("propose_correction"), names.join(","));
  assert(!names.some((n) => /donat|donor|giving/.test(n)), "fundraising tool leaked");
  return `${names.length} tools`;
});
await check("unknown method", async () => {
  const r = await call("POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "nope" });
  assert(r.body.error?.code === -32601, JSON.stringify(r.body));
});
await check("GET /mcp -> 405", async () => assert((await call("GET", "/mcp")).status === 405, "not 405"));
await check("crosswalk crm", async () => {
  const r = await call("GET", "/tools/lookup_crosswalk?scheme=crm&code=activities");
  assert(r.body.rows.length > 0, "no rows");
  return `${r.body.rows.length} rows`;
});
await check("naics-hs crosswalk", async () => {
  const r = await call("GET", "/tools/lookup_crosswalk?scheme=naics-hs&code=3361");
  assert(r.body.rows.length > 0, "no rows");
  return r.body.rows[0]["HS Description"];
});
await check("model results", async () => {
  const r = await call("GET", "/tools/get_model_results");
  assert(r.body.top_features?.length, JSON.stringify(r.body).slice(0, 200));
  return r.body.narration;
});
await check("data quality (toy)", async () => {
  const r = await call("POST", "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_data_quality", arguments: { scope: "GA" } } });
  return r.body.result.structuredContent.narration;
});
await check("correction without DB", async () => {
  const r = await call("POST", "/tools/propose_correction", { record_id: "org:ein:000000000", property: "status", note: "Office closed" });
  assert(r.body.activity?.status === "candidate" && r.body.stored === false, JSON.stringify(r.body));
});
await check("safety block on crisis text", async () => {
  const r = await call("GET", "/tools/lookup_crosswalk?scheme=crm&code=xyz&text=" + encodeURIComponent("I want to end my life"));
  assert(r.body.safety?.lines?.[0]?.how.includes("988"), "no safety block");
});
await check("llms.txt and openapi", async () => {
  const a = await call("GET", "/llms.txt");
  const b = await call("GET", "/openapi.json");
  assert(a.body.includes("/mcp") && b.body.openapi === "3.1.0", "bad discovery");
});

if (!offline) {
  await check("search_services by postal code", async () => {
    const r = await call("GET", "/tools/search_services?postal_code=30260&limit=5");
    assert(r.body.records?.length, JSON.stringify(r.body).slice(0, 300));
    assert(r.body.citations[0].license, "no license in citation");
    return r.body.narration;
  });
  await check("search_services by text", async () => {
    const r = await call("GET", "/tools/search_services?text=" + encodeURIComponent("PTSD counseling") + "&region=GA&limit=5");
    return r.body.narration;
  });
  await check("ask", async () => {
    const r = await call("POST", "/ask", { message: "I need help with housing", postal_code: "30260" });
    assert(r.body.answer, JSON.stringify(r.body).slice(0, 300));
    return `${r.body.intent}, ${r.body.records.length} records, flags ${JSON.stringify(r.body.flag_counts)}`;
  });
  await check("crisis_support", async () => {
    const r = await call("GET", "/tools/crisis_support?postal_code=30260");
    assert(r.body.safety, "no safety");
    return `${r.body.nearby.length} nearby`;
  });
  await check("get_coverage", async () => {
    const r = await call("GET", "/tools/get_coverage?region=GA&limit=3");
    return r.body.narration;
  });
  await check("get_county_profile", async () => {
    const r = await call("GET", "/tools/get_county_profile?county_fips=13063");
    assert(r.body.industries?.length, "no industries");
    return r.body.narration;
  });
  await check("get_stats", async () => (await call("GET", "/tools/get_stats?region=GA")).body.narration);
  await check("lookup_form (generic name)", async () => {
    const r = await call("GET", "/tools/lookup_form?form_id=21-526EZ");
    assert(r.body.result, JSON.stringify(r.body).slice(0, 300));
    return Object.keys(r.body.result).slice(0, 5).join(",");
  });
  await check("list_source_tools", async () => {
    const r = await call("GET", "/tools/list_source_tools?source_id=upstream-directory");
    return `${r.body.tools.length} upstream tools offered`;
  });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
