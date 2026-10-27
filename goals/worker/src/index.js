/**
 * Project Goals Worker: MCP server and data API.
 *
 * Runs on its own (wrangler.toml, BASE_PATH "") or mounted inside another
 * Worker at a path such as /api/goals (CloudRoot's worker/src/index.js
 * calls handleGoals). Routes, relative to BASE_PATH:
 *
 *   POST /mcp                    MCP over Streamable HTTP (JSON-RPC 2.0)
 *   GET  /tools                  Tool list (same as MCP tools/list)
 *   GET|POST /tools/<name>       Call a tool with query params or a JSON body
 *   POST /ask                    Shortcut for the ask tool
 *   GET  /health                 Status and connected sources
 *   GET  /openapi.json           OpenAPI 3.1 for the REST routes
 *   GET  /llms.txt               Plain-text guide for assistants
 *   GET  /agent.json             Agent card (also /.well-known/agent.json standalone)
 *
 * Everything else is served from static assets (the project folder).
 * The API is public and read-only apart from propose_correction, so it answers
 * any origin without credentials.
 */

import { handleMcp } from "./mcp.js";
import { runTool, toolTable, ToolError } from "./tools.js";
import { SOURCES, assetText } from "./sources.js";
import { loadProfileEvent } from "./event.js";
import veterans from "./profiles/veterans.js";

const PROFILES = { veterans };
const VERSION = "0.1.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const tableCache = new Map();
function setup(env) {
  const profile = PROFILES[env.PROFILE || "veterans"] || veterans;
  if (!tableCache.has(profile.id)) tableCache.set(profile.id, toolTable(profile));
  return { profile, tools: tableCache.get(profile.id) };
}

function json(data, status = 200, headers = {}) {
  if (data === null) return new Response(null, { status, headers: { ...CORS, ...headers } });
  return new Response(JSON.stringify(data, null, 1), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers },
  });
}
function text(body, type = "text/plain") {
  return new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8`, ...CORS } });
}

export const MOUNT = "/api/goals";
export function isGoalsPath(path, base = MOUNT) {
  return path === base || path.startsWith(base + "/");
}

function coerce(params) {
  const out = {};
  for (const [k, v] of params) {
    if (v === "true" || v === "false") out[k] = v === "true";
    else if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) && !/(postal_code|county_fips|form_id|code)$/.test(k)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function openapi(origin, base, tools) {
  const paths = {
    [`${base}/mcp`]: { post: { summary: "MCP endpoint (JSON-RPC 2.0, Streamable HTTP)", operationId: "mcp", responses: { 200: { description: "JSON-RPC response" } } } },
    [`${base}/tools`]: { get: { summary: "List tools", operationId: "listTools", responses: { 200: { description: "Tools" } } } },
  };
  for (const [name, t] of Object.entries(tools)) {
    const params = Object.entries(t.inputSchema.properties || {}).map(([p, schema]) => ({
      name: p, in: "query", required: (t.inputSchema.required || []).includes(p), schema,
    }));
    paths[`${base}/tools/${name}`] = {
      [t.annotations.readOnlyHint ? "get" : "post"]: {
        summary: t.title, description: t.description, operationId: name,
        ...(t.annotations.readOnlyHint ? { parameters: params } : { requestBody: { content: { "application/json": { schema: t.inputSchema } } } }),
        responses: { 200: { description: "Envelope: tool, generated_at, narration, results, citations, safety?" } },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: "Project Goals API", version: VERSION }, servers: [{ url: origin }], paths };
}

function llmsTxt(origin, base, profile, tools) {
  return `# MCP Endpoint

> Open data and tools for ${profile.audience}: services, benefits references, county
> industry context and data-quality signals, each result cited to its source.

MCP endpoint: ${origin}${base}/mcp (Streamable HTTP, no key)
REST: ${origin}${base}/tools/<tool>?<arguments>
OpenAPI: ${origin}${base}/openapi.json

## How to use
- Start with route_query using the person's own words.
- If a response has a "safety" block, show its lines first.
- Results are candidate records with sources, retrieval times and quality flags. Cite
  sources, mention flags that matter, and ask people to confirm details with providers.
- Report errors with propose_correction; corrections are reviewed by people.

## Tools
${Object.entries(tools).map(([n, t]) => `- ${n}: ${t.description}`).join("\n")}

## Safety
${profile.safety.lines.map((l) => `- ${l.name}: ${l.how}`).join("\n")}
`;
}

function agentCard(origin, base, profile, tools) {
  return {
    name: profile.name,
    description: `Data and tools for ${profile.audience}, with sourced, reviewable results.`,
    url: `${origin}${base}/mcp`,
    version: VERSION,
    capabilities: { streaming: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: Object.entries(tools).map(([id, t]) => ({ id, name: t.title, description: t.description })),
  };
}

export async function handleGoals(request, env, ctx, base = env.BASE_PATH || "") {
  const url = new URL(request.url);
  const path = url.pathname.slice(base.length) || "/";
  const origin = url.origin;
  const { profile, tools } = setup(env);
  await loadProfileEvent(env, profile);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    if (path === "/mcp") {
      if (request.method !== "POST") return json({ error: "Use POST for MCP (this server does not open SSE streams)" }, 405, { Allow: "POST, OPTIONS" });
      const asset = (p) => assetText(env, `${env.DATA_PREFIX || ""}${p}`);
      const info = { name: "goals", title: profile.name, version: VERSION };
      const { status, body } = await handleMcp(request, { env, profile, tools, info, asset });
      return json(body, status);
    }
    if (path === "/tools" && request.method === "GET") {
      return json({ tools: Object.entries(tools).map(([name, t]) => ({ name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
    }
    const m = path.match(/^\/tools\/([a-z_]+)$/);
    if (m || path === "/ask") {
      const name = m ? m[1] : "ask";
      const tool = tools[name];
      if (!tool) return json({ error: `Unknown tool: ${name}` }, 404);
      if (!tool.annotations.readOnlyHint && request.method !== "POST") return json({ error: `${name} needs POST` }, 405, { Allow: "POST, OPTIONS" });
      let args = coerce(url.searchParams);
      if (request.method === "POST") args = { ...args, ...(await request.json().catch(() => ({}))) };
      const missing = (tool.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === "");
      if (missing.length) return json({ error: `Missing: ${missing.join(", ")}` }, 400);
      return json(await runTool(env, profile, tools, name, args, "rest"));
    }
    if (path === "/health") {
      return json({ ok: true, version: VERSION, profile: profile.id, tools: Object.keys(tools).length, sources: Object.keys(SOURCES), review_queue: Boolean(env.DB) });
    }
    if (path === "/openapi.json") return json(openapi(origin, base, tools));
    if (path === "/llms.txt") return text(llmsTxt(origin, base, profile, tools));
    if (path === "/agent.json" || path === "/.well-known/agent.json") return json(agentCard(origin, base, profile, tools));
  } catch (err) {
    const status = err instanceof ToolError ? 400 : 502;
    return json({ error: err.message }, status);
  }

  if (env.ASSETS && !base) return env.ASSETS.fetch(request);
  return json({ error: `No route at ${url.pathname}` }, 404);
}

// Standalone: the same /api/goals paths as when mounted, so the page's API
// base doesn't change; everything else comes from the project folder.
export default {
  fetch(request, env, ctx) {
    const base = env.BASE_PATH ?? MOUNT;
    if (!base || isGoalsPath(new URL(request.url).pathname, base)) return handleGoals(request, env, ctx, base);
    return env.ASSETS.fetch(request);
  },
};
