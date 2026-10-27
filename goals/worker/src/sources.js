// External sources: the registry in pipeline/sources.json, an MCP client for
// upstream MCP servers, a REST helper, and small CSV/JSON loaders with a
// per-isolate cache. Every response that uses a source cites it.

import registry from "../../pipeline/sources.json" with { type: "json" };

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export const SOURCES = Object.fromEntries(registry.sources.map((s) => [s.source_id, s]));

export function sourceSetting(env, sourceId, key) {
  const src = SOURCES[sourceId] || {};
  const override = src.env_override?.[key];
  return (override && env[override]) || src[key];
}

export function citation(sourceId, extra = {}) {
  const s = SOURCES[sourceId] || {};
  return {
    source_id: sourceId,
    title: s.title,
    publisher: s.publisher,
    license: s.license,
    url: s.landing_page || s.openapi || s.api_url || s.url_template,
    ...extra,
  };
}

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res;
}

// Files that sit with the site (project/goals/data, /profile/...): through the
// ASSETS binding when present, else over HTTP from ASSET_ORIGIN.
export async function assetText(env, path) {
  return cached(`asset:${path}`, async () => {
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(new Request(new URL(path, "https://assets.local")));
      if (!res.ok) throw new Error(`${res.status} for ${path}`);
      return res.text();
    }
    if (!env.ASSET_ORIGIN) throw new Error(`No ASSETS binding or ASSET_ORIGIN for ${path}`);
    return (await fetchOk(new URL(path, env.ASSET_ORIGIN))).text();
  });
}

export async function urlText(url) {
  return cached(`url:${url}`, async () => (await fetchOk(url, { cf: { cacheTtl: 3600 } })).text());
}

// Minimal RFC 4180 CSV parser: quoted fields, embedded commas and quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// --- Upstream MCP -----------------------------------------------------------

let rpcId = 0;
const sessions = new Map();

async function readRpc(res) {
  const type = res.headers.get("Content-Type") || "";
  const text = await res.text();
  if (type.includes("text/event-stream")) {
    // Streamable HTTP may answer as SSE: take the last JSON data line.
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(data[data.length - 1] || "{}");
  }
  return JSON.parse(text || "{}");
}

async function rpc(url, method, params, session) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = res.status === 202 ? {} : await readRpc(res);
  return { res, body };
}

// Calls a tool on an upstream MCP server. Stateless servers answer directly;
// one that wants a session gets initialize first, and the session is reused.
export async function mcpCall(env, sourceId, name, args = {}) {
  const url = sourceSetting(env, sourceId, "mcp_url");
  if (!url) throw new Error(`Source ${sourceId} has no MCP URL`);
  const excluded = SOURCES[sourceId]?.exclude_tools || [];
  if (excluded.includes(name)) throw new Error(`Tool ${name} is not offered from ${sourceId}`);
  let { res, body } = await rpc(url, "tools/call", { name, arguments: args }, sessions.get(url));
  if (res.status === 400 || res.status === 404 || body.error?.code === -32600) {
    const init = await rpc(url, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "goals", version: "0.1.0" },
    });
    const session = init.res.headers.get("Mcp-Session-Id");
    if (session) sessions.set(url, session);
    await rpc(url, "notifications/initialized", undefined, session);
    ({ res, body } = await rpc(url, "tools/call", { name, arguments: args }, session));
  }
  if (body.error) throw new Error(`${sourceId}: ${body.error.message || "error"}`);
  const result = body.result || {};
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try { return JSON.parse(text); } catch { return { text }; }
}

export async function mcpListTools(env, sourceId) {
  const url = sourceSetting(env, sourceId, "mcp_url");
  return cached(`tools:${url}`, async () => {
    const { body } = await rpc(url, "tools/list", {}, sessions.get(url));
    const excluded = SOURCES[sourceId]?.exclude_tools || [];
    return (body.result?.tools || []).filter((t) => !excluded.includes(t.name));
  });
}

export async function restGet(env, sourceId, path, params = {}) {
  const base = String(sourceSetting(env, sourceId, "api_url") || "").replace(/\/$/, "");
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  return cached(`rest:${url}`, async () => (await fetchOk(url, { headers: { Accept: "application/json" } })).json());
}

export async function restPost(env, sourceId, path, body) {
  const base = String(sourceSetting(env, sourceId, "api_url") || "").replace(/\/$/, "");
  const res = await fetchOk(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

// The attribution an upstream asks for, read from its own response.
export function upstreamAttribution(data) {
  const meta = data?._meta || {};
  if (!meta.license && !meta.publisher) return {};
  return {
    publisher: meta.publisher?.name,
    license: meta.license,
    license_url: meta.license_url,
    cite_as: meta.cite_as,
    attribution_required: meta.attribution_required,
  };
}
