// MCP server over Streamable HTTP: JSON-RPC 2.0 on POST, answered as JSON.
// Stateless, so any isolate can serve any request; no session id is issued.

import { runTool, ToolError } from "./tools.js";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function fail(id, code, message, data) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }; }

function listTools(tools) {
  return Object.entries(tools).map(([name, t]) => ({
    name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations },
  }));
}

async function handleOne(msg, ctx) {
  const { env, profile, tools, info } = ctx;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id, -32600, "Invalid request");
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1],
        serverInfo: info,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        instructions: `${profile.name} serves ${profile.audience}. Call route_query first with the person's words. ` +
          "If any result includes a safety block, show its lines before anything else. Results are candidate records " +
          "with sources and quality flags: cite the sources, mention flags that affect the answer, and ask the person to " +
          "confirm details with the provider. Use propose_correction when someone reports an error.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: listTools(tools) });
    case "tools/call": {
      try {
        const result = await runTool(env, profile, tools, params.name, params.arguments || {}, "mcp");
        const content = [];
        if (result.safety) content.push({ type: "text", text: `${result.safety.message}\n` + result.safety.lines.map((l) => `${l.name}: ${l.how}`).join("\n") });
        content.push({ type: "text", text: JSON.stringify(result) });
        return ok(id, { content, structuredContent: result });
      } catch (err) {
        if (err instanceof ToolError && /^Unknown tool/.test(err.message)) return fail(id, -32602, err.message);
        return ok(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    case "resources/list":
      return ok(id, {
        resources: [
          { uri: "goals://sources", name: "Sources", mimeType: "application/json", description: "Registry of external sources" },
          { uri: "goals://schema/record", name: "Record schema", mimeType: "application/schema+json" },
          { uri: "goals://schema/scene", name: "Scene schema", mimeType: "application/schema+json" },
          { uri: "goals://profile", name: "Domain profile", mimeType: "application/json" },
        ],
      });
    case "resources/read": {
      const uri = params.uri;
      let body;
      if (uri === "goals://sources") body = (await runTool(env, profile, tools, "list_sources", {})).sources;
      else if (uri === "goals://profile") {
        const { safety, upstream, ...rest } = profile;
        body = { ...rest, safety: { message: safety.message, lines: safety.lines } };
      } else if (uri?.startsWith("goals://schema/")) {
        const name = uri.split("/").pop();
        body = JSON.parse(await ctx.asset(`/schema/${name}.schema.json`));
      } else return fail(id, -32602, `Unknown resource ${uri}`);
      return ok(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }] });
    }
    case "prompts/list":
      return ok(id, {
        prompts: [
          { name: "find_help", title: "Find help near me", arguments: [{ name: "need", required: true }, { name: "postal_code", required: false }] },
          { name: "county_brief", title: "County brief", arguments: [{ name: "county_fips", required: true }] },
        ],
      });
    case "prompts/get": {
      const a = params.arguments || {};
      const text = params.name === "county_brief"
        ? `Use get_county_profile and get_coverage for county ${a.county_fips}. Summarize industries, listed services and data-quality caveats in five sentences, citing sources.`
        : `I'm looking for help with: ${a.need}${a.postal_code ? ` near ${a.postal_code}` : ""}. Use route_query, then search_services. Show safety lines first if present, cite sources, and note quality flags.`;
      return ok(id, { messages: [{ role: "user", content: { type: "text", text } }] });
    }
    default:
      return isNotification ? null : fail(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, ctx) {
  let body;
  try { body = await request.json(); } catch { return { status: 400, body: fail(null, -32700, "Parse error") }; }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const out = await handleOne(body, ctx);
  return out ? { status: 200, body: out } : { status: 202, body: null };
}
