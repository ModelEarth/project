// Location-based search across the services in pipeline/services.json. One
// path serves an upstream MCP server (the veteran directory), REST APIs and
// OpenStreetMap (Overpass): each service's search block says what place it
// needs, how to ask the upstream, and how its records map to the same
// claim-level records search_services returns. The place (ZIP, city, region
// or point) is resolved only when a service needs more than it was given.

import catalog from "../../pipeline/services.json" with { type: "json" };
import { citation, jsonGet, mcpCall, upstreamAttribution } from "./sources.js";

export class ToolError extends Error {}

export const CATALOG = catalog;
export const SERVICES = Object.fromEntries(catalog.services.map((s) => [s.id, s]));

// A service's search block, with "extends" filled in from the service it
// builds on (the job centers search is the directory search with a type).
export function searchSpec(service) {
  const base = service.extends ? searchSpec(SERVICES[service.extends]) : null;
  return { ...(base || {}), ...(service.search || {}), vars: { ...(base?.vars || {}), ...(service.vars || {}) } };
}
// The fields an extended service shares with the one it builds on.
function inherited(service, key) {
  return service[key] ?? (service.extends ? inherited(SERVICES[service.extends], key) : undefined);
}

// live, needs_key (live once its requires_env secrets are set) or planned.
export function serviceState(env, service) {
  if (service.status === "planned") return { ready: false, state: "planned" };
  const missing = (inherited(service, "requires_env") || []).filter((k) => !env[k]);
  if (missing.length) return { ready: false, state: "needs_key", missing };
  return { ready: true, state: "live" };
}

export function serviceCitation(service, data) {
  const sourceId = inherited(service, "source_id");
  if (sourceId && inherited(service, "attribution_from_response")) return citation(sourceId, upstreamAttribution(data));
  return { source_id: service.id, title: service.title, publisher: inherited(service, "publisher"), license: inherited(service, "license"), url: inherited(service, "landing_page") };
}

// --- Templates and paths ----------------------------------------------------------

// "{name}" or "{name|default}" from the request, "{env.NAME}" from the Worker's
// secrets. A value that is a single placeholder keeps its type (numbers stay
// numbers). In a longer string, a placeholder with no value and no default
// empties the whole string, so the parameter is left out.
const PLACEHOLDER = /\{([^{}|]+)(?:\|([^{}]*))?\}/g;
function fill(template, lookup) {
  if (typeof template !== "string") return template;
  const whole = template.match(/^\{([^{}|]+)(?:\|([^{}]*))?\}$/);
  if (whole) {
    const v = lookup(whole[1]);
    return v == null || v === "" ? whole[2] : v;
  }
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_, k, d) => {
    const v = lookup(k);
    if (v != null && v !== "") return String(v);
    if (d === undefined) missing = true;
    return d;
  });
  return missing ? undefined : out.trim();
}
function fillEach(obj = {}, lookup) {
  const out = {};
  for (const [k, t] of Object.entries(obj)) {
    const v = fill(t, lookup);
    if (v != null && v !== "") out[k] = v;
  }
  return out;
}
function withParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
}

// "a.b.0.c" into nested objects and arrays. A key that itself holds dots
// ("school.name" in College Scorecard rows) is read whole first.
// "list[key=value]" picks the first item of list whose key is value.
export function getPath(obj, path) {
  if (path == null || path === "") return obj;
  if (obj == null || typeof obj !== "object") return undefined;
  if (path in obj) return obj[path];
  const dot = path.indexOf(".");
  const head = dot < 0 ? path : path.slice(0, dot);
  const rest = dot < 0 ? "" : path.slice(dot + 1);
  const m = head.match(/^(.+)\[([^=\]]+)=([^\]]*)\]$/);
  const next = m ? (Array.isArray(obj[m[1]]) ? obj[m[1]].find((x) => String(x?.[m[2]]) === m[3]) : undefined) : obj[head];
  return rest ? getPath(next, rest) : next;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const TRANSFORMS = {
  strip_html: (v) => String(v).replace(/<[^>]+>/g, " ").replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === "#"
    ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ENTITIES[e.toLowerCase()] ?? m)).replace(/\s+/g, " ").trim(),
  first_paragraph: (v) => String(v).split(/<p>|\n/i)[0],
  after_first_paragraph: (v) => String(v).split(/<p>|\n/i).slice(1).join(" "),
  clip: (v) => (String(v).length > 180 ? `${String(v).slice(0, 177).trimEnd()}…` : v),
  clip_short: (v) => (String(v).length > 110 ? `${String(v).slice(0, 107).trimEnd()}…` : v),
  https: (v) => (!v || /^n\/?a$/i.test(v) ? undefined : /^https?:\/\//i.test(v) ? v : `https://${String(v).replace(/^\/+/, "")}`),
  zip5: (v) => String(v).match(/^\d{5}/)?.[0] ?? v,
  title_case: (v) => (String(v) === String(v).toUpperCase() ? String(v).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : v),
  humanize: (v) => String(v).replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
  date: (v) => String(v).slice(0, 10),
  last_segment: (v) => String(v).split("/").pop(),
};

// A field spec: a path, a list of fallbacks, { join, sep }, { template },
// { value }, or { path, transform, map }. Templates read the record first,
// then the request's vars.
function pick(obj, spec, vars = {}) {
  if (spec == null) return undefined;
  if (typeof spec === "string") return blankless(getPath(obj, spec));
  if (Array.isArray(spec)) {
    for (const s of spec) { const v = pick(obj, s, vars); if (v != null) return v; }
    return undefined;
  }
  if ("value" in spec) return spec.value;
  if (spec.join) return blankless(spec.join.map((s) => pick(obj, s, vars)).filter((v) => v != null).join(spec.sep ?? " "));
  if (spec.template) return blankless(fill(spec.template, (k) => blankless(getPath(obj, k)) ?? vars[k]));
  let v = blankless(getPath(obj, spec.path));
  if (v != null && spec.map) v = spec.map[String(v)] ?? spec.map["*"] ?? v;
  for (const t of [].concat(spec.transform || [])) if (v != null) v = blankless(TRANSFORMS[t]?.(v) ?? v);
  return v;
}
function blankless(v) {
  if (v == null) return undefined;
  if (typeof v === "string" && !v.trim()) return undefined;
  return v;
}
function records(data, path) {
  for (const p of [].concat(path ?? "")) {
    const v = getPath(data, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

// --- Place --------------------------------------------------------------------------

const STOP = new Set("a an and any are as at be best by can do find for from get good help how i in is it job jobs looking me my near nearby need of on or our some that the their them there to uses using want what where which who with work you your".split(" "));
const LANGUAGES = ["python", "javascript", "typescript", "java", "rust", "go", "golang", "ruby", "php", "swift", "kotlin", "c++", "c#", "julia", "r", "scala", "elixir", "haskell", "dart"];
export function keywords(text = "") {
  return String(text).toLowerCase().match(/[a-z0-9+#.-]+/g)?.filter((w) => w.length > 2 && !STOP.has(w) && !/^\d{5}$/.test(w)) || [];
}
function languageIn(text = "") {
  const words = String(text).toLowerCase().match(/[a-z0-9+#]+/g) || [];
  const hit = LANGUAGES.find((l) => words.includes(l));
  return hit === "golang" ? "go" : hit;
}

// Fills the place's missing parts from Zippopotam.us: a ZIP gives the point,
// city and state; a city and state give the point and a ZIP.
const NEEDS = { point: ["lat", "lng"], postal_code: ["postal_code"], locality: ["locality", "region"], region: ["region"] };
export async function resolvePlace(args, needs) {
  const place = {
    postal_code: args.postal_code ? String(args.postal_code).trim() : undefined,
    locality: args.city || undefined,
    region: args.region ? String(args.region).toUpperCase() : undefined,
    lat: args.lat != null && args.lat !== "" ? Number(args.lat) : undefined,
    lng: args.lng != null && args.lng !== "" ? Number(args.lng) : undefined,
  };
  const want = NEEDS[needs] || [];
  if (want.every((k) => place[k] != null)) return place;
  let p;
  if (place.postal_code) {
    if (!/^\d{5}$/.test(place.postal_code)) throw new ToolError("postal_code should be a 5-digit ZIP.");
    p = (await jsonGet(`https://api.zippopotam.us/us/${place.postal_code}`).catch(() => null))?.places?.[0];
    if (!p) throw new ToolError(`Couldn't place ZIP ${place.postal_code}.`);
  } else if (place.locality && place.region) {
    p = (await jsonGet(`https://api.zippopotam.us/us/${place.region}/${encodeURIComponent(place.locality)}`).catch(() => null))?.places?.[0];
    if (!p) throw new ToolError(`Couldn't place ${place.locality}, ${place.region}.`);
    place.postal_code = p["post code"];
  }
  if (p) {
    place.lat ??= Number(p.latitude);
    place.lng ??= Number(p.longitude);
    place.locality ??= p["place name"];
    place.region ??= p["state abbreviation"];
    place.resolved_by = "zippopotam";
  }
  const missing = want.filter((k) => place[k] == null);
  if (missing.length) throw new ToolError(needs === "region" ? "Give a ZIP or a two-letter state (region)." : "Give a ZIP, or a city and two-letter state.");
  return place;
}

function miles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// --- Records ----------------------------------------------------------------------

const PLACEHOLDER_ZIP = /^(0{5}|9{5}|12345)$/;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const CRM_TABLE = { organization: "accounts", location: "accounts", offering: "products", event: "events" };

// OpenStreetMap elements from Overpass: the same fields for every tag set.
const OSM_FIELDS = {
  id: { template: "{type}-{id}" },
  name: "tags.name",
  street: { join: ["tags.addr:housenumber", "tags.addr:street"] },
  locality: "tags.addr:city",
  region: "tags.addr:state",
  postal_code: "tags.addr:postcode",
  phone: ["tags.phone", "tags.contact:phone"],
  url: ["tags.website", "tags.contact:website", "tags.url"].map((path) => ({ path, transform: "https" })),
  lat: ["lat", "center.lat"],
  lng: ["lon", "center.lon"],
  detail: ["tags.operator", "tags.description"],
  source_url: { template: "https://www.openstreetmap.org/{type}/{id}" },
};

function recordFlags(r, fields, coordCounts) {
  const flags = [];
  if (fields.postal_code && (!r.address.postal_code || PLACEHOLDER_ZIP.test(String(r.address.postal_code)))) flags.push("placeholder_postal_code");
  if (r.address.street && r.address.locality && r.address.street.trim().toLowerCase() === r.address.locality.trim().toLowerCase()) flags.push("address_is_locality");
  if ((fields.phone || fields.url) && !r.phone && !r.url) flags.push("no_contact");
  if (r.geo && coordCounts.get(`${r.geo.lat},${r.geo.lng}`) > 1) flags.push("shared_coordinates");
  if (r.completeness_score != null && r.completeness_score < 2) flags.push("thin_record");
  return flags;
}

// Upstream items into claim-level records (record.schema.json): every value a
// claim with its source, retrieval time, origin and review state, plus quality
// flags. categoryOf maps an upstream type to a profile category ("category_map":
// "profile"); otherwise the service's own category and label apply.
export function normalizeRecords(service, items = [], { at = new Date().toISOString(), place, vars = {}, categoryOf } = {}) {
  const spec = searchSpec(service);
  const fields = spec.fields || (inherited(service, "kind") === "overpass" ? OSM_FIELDS : {});
  const sourceId = inherited(service, "source_id") || service.id;
  const scheme = inherited(service, "id_scheme") || service.id.replace(/-/g, "_");
  const entity = inherited(service, "entity_type") || "organization";
  const rows = items.map((it) => {
    const get = (k) => pick(it, fields[k], vars);
    const lat = Number(get("lat")), lng = Number(get("lng"));
    const geo = Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null;
    const type = get("type");
    let label = get("label");
    if (!label && spec.tags) {
      const tag = spec.tags.find((t) => t.split(",").every((kv) => { const [k, v] = kv.split("="); return it.tags?.[k] === v; }));
      label = tag ? TRANSFORMS.humanize(tag.split(",").pop().split("=")[1]) : undefined;
    }
    const mapped = categoryOf ? categoryOf(type) : null;
    let distance = get("distance_miles");
    distance = distance != null && distance !== "" && Number.isFinite(Number(distance)) ? Number(distance) : undefined;
    if (distance == null && geo && place?.lat != null) distance = miles(place, geo);
    return {
      rawId: get("id"), type, subtype: get("subtype"), geo,
      category: mapped?.id || service.categories?.[0],
      category_label: mapped?.label || label || service.short || service.title,
      name: get("name"), detail: get("detail"), date: get("date"),
      address: { street: get("street") ?? null, locality: get("locality") ?? null, region: get("region") ?? null, postal_code: get("postal_code") != null ? String(get("postal_code")) : null },
      phone: get("phone") ?? null, url: get("url") ?? null, source_url: get("source_url"),
      services: Array.isArray(get("services")) ? get("services") : [],
      distance_miles: distance != null ? Math.round(distance * 10) / 10 : undefined,
      relevance: get("relevance"), completeness_score: get("completeness_score"), notes: get("notes"),
    };
  }).filter((r) => r.name);

  const coordCounts = new Map();
  for (const r of rows) if (r.geo) coordCounts.set(`${r.geo.lat},${r.geo.lng}`, (coordCounts.get(`${r.geo.lat},${r.geo.lng}`) || 0) + 1);
  return rows.map((r) => {
    const entityType = typeof entity === "string" ? entity : entity[r.type] || entity["*"] || "organization";
    const claim = (property, value, extra = {}) =>
      value == null || value === "" ? null : { property, value, source_id: sourceId, retrieved_at: at, origin: "source_extracted", review_state: "candidate", confidence: null, ...extra };
    const hasAddress = Object.values(r.address).some((v) => v != null);
    return {
      id: r.rawId != null ? `svc:${scheme}:${String(r.rawId).replace(/[^A-Za-z0-9_.-]/g, "-")}` : `svc:${scheme}:${slug(r.name)}-${r.address.postal_code || "nozip"}`,
      service_id: service.id,
      entity_type: entityType,
      crm_table: CRM_TABLE[entityType] || "accounts",
      name: r.name,
      category: r.category,
      category_label: r.category_label,
      detail: r.detail,
      date: r.date,
      address: r.address,
      phone: r.phone,
      url: r.url,
      source_url: r.source_url,
      services: r.services,
      distance_miles: r.distance_miles,
      relevance: r.relevance || undefined,
      completeness_score: r.completeness_score ?? undefined,
      notes: r.notes || undefined,
      origin: "source_extracted",
      review_state: "candidate",
      flags: recordFlags(r, fields, coordCounts),
      claims: [
        claim("name", r.name),
        hasAddress ? claim("address", r.address) : null,
        claim("phone", r.phone),
        claim("url", r.url),
        claim("category", r.category, r.type != null ? { evidence: { upstream_type: r.type, upstream_subtype: r.subtype } } : {}),
        r.geo ? claim("geo", r.geo, { method: "upstream geocode" }) : null,
      ].filter(Boolean),
    };
  });
}

// --- Search -------------------------------------------------------------------------

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
function overpassQuery(spec, vars) {
  const around = `(around:${vars.radius_m},${vars.lat},${vars.lng})`;
  const parts = spec.tags.map((t) => `nwr${around}${t.split(",").map((kv) => { const [k, v] = kv.split("="); return `["${k}"="${v}"]`; }).join("")};`);
  return `[out:json][timeout:25];(${parts.join("")});out center tags ${Math.max(vars.limit * 4, 40)};`;
}

async function prelude(spec, lookup) {
  const data = await jsonGet(withParams(spec.url, fillEach(spec.params, lookup)));
  const hit = records(data, spec.records).find((it) => Object.entries(spec.match || {}).every(([k, v]) => String(getPath(it, k) ?? "").includes(v)));
  if (!hit) throw new Error(`Nothing in ${new URL(spec.url).host} matched ${JSON.stringify(spec.match)}`);
  return Object.fromEntries(Object.entries(spec.vars || {}).map(([k, p]) => [k, getPath(hit, p)]));
}

// Runs one service's search. args: text, postal_code, city, region, lat, lng,
// radius_miles, limit, specialty. opts.vars adds request values the profile
// supplies (category_upstream); opts.categoryOf maps upstream types.
export async function searchNearby(env, service, args = {}, opts = {}) {
  const state = serviceState(env, service);
  if (!state.ready) throw new ToolError(state.state === "planned" ? `${service.title} is planned, not yet connected.` : `${service.title} needs ${state.missing.join(" and ")} set on the Worker.`);
  const spec = searchSpec(service);
  const at = opts.at || new Date().toISOString();
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const radius = Math.min(Number(args.radius_miles) || spec.radius_miles || 10, spec.max_radius_miles || 200);
  const place = await resolvePlace(args, spec.needs);
  const words = keywords(args.text);
  const vars = {
    ...place, text: args.text || undefined, keywords: words.join(" ") || undefined, keyword: words[0], language: languageIn(args.text),
    radius_miles: radius, radius_m: Math.round(radius * 1609.34), radius_km: Math.round(radius * 16.0934) / 10,
    limit, specialty: args.specialty, ...spec.vars, ...opts.vars,
  };
  const lookup = (k) => (k.startsWith("env.") ? env[k.slice(4)] : vars[k]);
  if (spec.prelude) Object.assign(vars, await prelude(spec.prelude, lookup));
  const variant = spec.variants ? spec.variants.find((v) => (v.when || []).every((k) => vars[k] != null && vars[k] !== "")) : spec;
  if (!variant) throw new ToolError(`${service.title} needs ${spec.variants.map((v) => (v.when || []).join(" and ")).join(", or ")}.`);
  const call = { ...spec, ...variant };

  let data;
  const kind = inherited(service, "kind");
  if (kind === "overpass") {
    // The public Overpass servers are slow (often 20-40 seconds) and turn
    // requests away when busy, so two are asked at once and the first answer
    // is used (OVERPASS_URL alone when set).
    const query = encodeURIComponent(overpassQuery(spec, vars));
    const bases = env.OVERPASS_URL ? [env.OVERPASS_URL] : OVERPASS;
    data = await Promise.any(bases.map((base) => jsonGet(`${base}?data=${query}`, {}, { timeoutMs: 45000 })))
      .catch(() => { throw new Error("OpenStreetMap's Overpass servers are busy; try again in a minute."); });
  } else if (kind === "mcp") {
    data = await mcpCall(env, inherited(service, "source_id"), call.tool, fillEach(call.args, lookup));
  } else {
    data = await jsonGet(withParams(call.url, fillEach(call.params, lookup)), fillEach(call.headers, lookup));
  }

  let items = records(data, spec.records ?? (kind === "overpass" ? "elements" : ""));
  // Only items whose values match (top-level Hacker News comments: the posts, not replies).
  if (spec.where) items = items.filter((it) => Object.entries(spec.where).every(([k, t]) => String(getPath(it, k)) === String(fill(t, lookup))));
  if (spec.unique) {
    // One record per value (FEMA lists a declaration once per county).
    const seen = new Set();
    items = items.filter((it) => { const key = getPath(it, spec.unique); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  const list = normalizeRecords(service, items, { at, place, vars, categoryOf: opts.categoryOf });
  if (spec.sort_by_distance !== false) list.sort((a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity));
  // Nothing found: once more without the request values the service lists
  // under relax (Hacker News needs every word of its query in a post).
  const relax = (spec.relax || []).filter((k) => vars[k] != null && !(k in (opts.vars || {})));
  if (!list.length && relax.length) {
    const again = await searchNearby(env, service, args, { ...opts, vars: { ...opts.vars, ...Object.fromEntries(relax.map((k) => [k, undefined])) } });
    return { ...again, relaxed: relax };
  }
  const total = spec.unique ? list.length : pick(data, spec.total);
  return { data, records: list.slice(0, limit), total: total != null ? Number(total) : list.length, place, radius_miles: radius, needs: spec.needs ?? null, vars };
}

// The catalog as list_services returns it: each service's state on this Worker.
export function catalogView(env, { audience, category } = {}) {
  const cats = catalog.categories.filter((c) => !audience || c.audiences.includes(audience));
  const ids = new Set(cats.map((c) => c.id));
  const services = catalog.services.filter((s) => (!category || s.categories.includes(category)) && s.categories.some((c) => ids.has(c))).map((s) => {
    const st = serviceState(env, s);
    return {
      id: s.id, title: s.title, short: s.short, summary: s.summary, categories: s.categories, kind: inherited(s, "kind"),
      state: st.state, needs_env: st.missing, needs: searchSpec(s).needs ?? null, keywords: s.keywords,
      publisher: inherited(s, "publisher"), license: inherited(s, "license"), landing_page: inherited(s, "landing_page"),
      featured: catalog.featured.includes(s.id) || undefined, default_selected: catalog.default_selected.includes(s.id) || undefined,
    };
  });
  return { audiences: catalog.audiences, categories: cats, featured: catalog.featured, default_selected: catalog.default_selected, services };
}

// Services whose keywords appear in the text, for route_query.
export function servicesFor(env, text = "") {
  const t = ` ${String(text).toLowerCase()} `;
  return catalog.services.filter((s) => serviceState(env, s).ready && (s.keywords || []).some((k) => t.includes(k)));
}
