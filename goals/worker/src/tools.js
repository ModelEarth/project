// Tool definitions and handlers. Names and parameters are generic
// (postal_code, region, county_fips, category, text) so the same tools serve
// any CRM-backed directory; the profile maps them to each source's terms.
//
// Every handler returns an envelope:
//   { tool, generated_at, narration, ...results, flags?, citations, safety? }
// narration is one plain sentence suitable for captions or a voice-over.

import { SOURCES, assetText, citation, mcpCall, mcpListTools, parseCsv, restGet, restPost, sourceSetting, upstreamAttribution, urlText } from "./sources.js";
import { checkSafety, safetyBlock } from "./safety.js";
import { NAICS2 } from "./naics.js";

const UP = "upstream-directory";
const now = () => new Date().toISOString();

// --- Normalizing upstream records into claim-level records -------------------

const PLACEHOLDER_ZIP = /^(0{5}|9{5}|12345)$/;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function recordFlags(r, coordCounts) {
  const flags = [];
  if (!r.zip || PLACEHOLDER_ZIP.test(String(r.zip))) flags.push("placeholder_postal_code");
  if (r.address && r.city && r.address.trim().toLowerCase() === r.city.trim().toLowerCase()) flags.push("address_is_locality");
  if (!r.phone && !r.website) flags.push("no_contact");
  if (r.lat != null && coordCounts.get(`${r.lat},${r.lng}`) > 1) flags.push("shared_coordinates");
  if (r.completeness_score != null && r.completeness_score < 2) flags.push("thin_record");
  return flags;
}

function categoryFor(profile, upstreamType) {
  for (const [id, c] of Object.entries(profile.categories)) if (c.upstream === upstreamType) return id;
  return "other";
}

export function normalizeResources(profile, resources = [], retrievedAt = now()) {
  const coordCounts = new Map();
  for (const r of resources) if (r.lat != null) coordCounts.set(`${r.lat},${r.lng}`, (coordCounts.get(`${r.lat},${r.lng}`) || 0) + 1);
  return resources.map((r) => {
    const flags = recordFlags(r, coordCounts);
    const claim = (property, value, extra = {}) =>
      value == null || value === "" ? null : { property, value, source_id: UP, retrieved_at: retrievedAt, origin: "source_extracted", review_state: "candidate", confidence: null, ...extra };
    const category = categoryFor(profile, r.resource_type);
    return {
      id: r.id != null ? `svc:${UP}:${r.id}` : `svc:${UP}:${slug(r.name)}-${r.zip || "nozip"}`,
      entity_type: r.resource_type === "vso" ? "organization" : "offering",
      crm_table: r.resource_type === "vso" ? "accounts" : "products",
      name: r.name,
      category,
      category_label: profile.categories[category]?.label,
      address: { street: r.address || null, locality: r.city || null, region: r.state || null, postal_code: r.zip || null },
      phone: r.phone || null,
      url: r.website || null,
      services: Array.isArray(r.services) ? r.services : [],
      distance_miles: r.distance != null ? Number(r.distance) : r.distance_miles ?? undefined,
      relevance: r.veteran_relevance || undefined,
      completeness_score: r.completeness_score ?? undefined,
      notes: r.notes || undefined,
      origin: "source_extracted",
      review_state: "candidate",
      flags,
      claims: [
        claim("name", r.name),
        claim("address", { street: r.address, locality: r.city, region: r.state, postal_code: r.zip }),
        claim("phone", r.phone),
        claim("url", r.website),
        claim("category", category, { evidence: { upstream_type: r.resource_type, upstream_subtype: r.resource_subtype } }),
        r.lat != null ? claim("geo", { lat: r.lat, lng: r.lng }, { method: "upstream geocode" }) : null,
      ].filter(Boolean),
    };
  });
}

// Lines in upstream prose that promote the upstream publisher itself are
// dropped; its attribution stays in the citations.
function withoutSelfPromotion(text, publisher) {
  if (!text || !publisher) return text;
  const name = publisher.toLowerCase();
  return text.split("\n").filter((line) => !line.toLowerCase().includes(name)).join("\n");
}

function upstreamCitation(data) {
  return citation(UP, upstreamAttribution(data));
}

function flagSummary(records) {
  const counts = {};
  for (const r of records) for (const f of r.flags) counts[f] = (counts[f] || 0) + 1;
  return counts;
}

// --- County data (external, with toy files as fallback) ----------------------

// 2-digit sectors from the naics2 file (31, 44 and 48 stand for 31-33, 44-45
// and 48-49). Files from before October 2026 lacked those three, so when one is
// missing the sector is rolled up from the naics4 file instead.
async function communityIndustries(env, region, year = 2023) {
  const tpl = SOURCES["community-industries"].url_template;
  const url = (level) => tpl.replaceAll("{state}", region).replace("{level}", level).replace("{year}", year);
  const byCounty = {};
  const add = (r, sector) => {
    const fips = String(r.Fips).padStart(5, "0");
    const cell = ((byCounty[fips] ||= {})[sector] ||= { employees: 0, establishments: 0, payroll: 0 });
    cell.employees += Number(r.Employees) || 0;
    cell.establishments += Number(r.Establishments) || 0;
    cell.payroll += Number(r.Payroll) || 0;
  };
  const rows2 = parseCsv(await urlText(url("2")));
  for (const r of rows2) if (/^\d\d$/.test(String(r.Naics || ""))) add(r, String(r.Naics));
  const present = new Set(rows2.map((r) => String(r.Naics)));
  const missing = ["31", "44", "48"].filter((s) => !present.has(s));
  if (missing.length) {
    for (const r of parseCsv(await urlText(url("4")))) {
      const code = String(r.Naics || "").slice(0, 2);
      const sector = { 32: "31", 33: "31", 45: "44", 49: "48" }[code] || code;
      if (missing.includes(sector)) add(r, sector);
    }
  }
  return byCounty;
}

async function toyCounties(env, region) {
  const prefix = env.DATA_PREFIX || "";
  for (const scope of [region, "AL-FL-GA-NC-SC-TN"]) {
    try {
      const rows = parseCsv(await assetText(env, `${prefix}/data/toy/${scope}/county-summary.csv`));
      const mine = rows.filter((r) => r.Region === region);
      if (mine.length) return { rows: mine, scope };
    } catch { /* try the next scope */ }
  }
  return { rows: [], scope: null };
}

const STATE_OF_FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
  "56": "WY", "72": "PR",
};

// --- Tool table ---------------------------------------------------------------

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const REGION = str("Two-letter state or territory code, e.g. GA", { pattern: "^[A-Za-z]{2}$" });
const POSTAL = str("5-digit US postal code", { pattern: "^\\d{5}$" });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function toolTable(profile) {
  const categoryIds = Object.keys(profile.categories);
  const T = {
    route_query: {
      title: "Route a question",
      description: `Start here with any free-text request from ${profile.audience}. Checks for crisis language first, then suggests which tool and arguments to use next.`,
      inputSchema: { type: "object", properties: { text: str("The person's request in their own words"), postal_code: POSTAL }, required: ["text"] },
      annotations: READ,
      run: async (env, a) => {
        const upstream = await mcpCall(env, UP, "route_query", { query: a.text }).catch(() => null);
        const zip = a.postal_code || (a.text.match(/\b\d{5}\b/) || [])[0];
        const suggestions = [];
        if (zip) suggestions.push({ tool: "search_services", arguments: { text: a.text, postal_code: zip } });
        else suggestions.push({ tool: "search_services", arguments: { text: a.text }, note: "Ask for a postal code or city for local results" });
        if (/\bform\b|\b\d{2}-\d{3,4}/i.test(a.text)) suggestions.push({ tool: "lookup_form", arguments: { form_id: (a.text.match(/\b\d{2}-\d{3,4}[a-z]*\b/i) || [])[0] } });
        if (/eligib|qualif/i.test(a.text)) suggestions.push({ tool: "check_eligibility", arguments: {} });
        if (/county|industr|trend|forecast/i.test(a.text)) suggestions.push({ tool: "get_county_profile", arguments: {} });
        return {
          narration: `Suggested ${suggestions[0].tool} for this request.`,
          suggestions,
          upstream_hint: upstream?.best_match || null,
          citations: upstream ? [upstreamCitation(upstream)] : [],
        };
      },
    },

    search_services: {
      title: "Search services",
      description: "Find services and organizations by text, postal code, city or region. Results are claim-level records with source, retrieval time, review state and quality flags. Always confirm availability with the provider.",
      inputSchema: {
        type: "object",
        properties: {
          text: str("Keywords, e.g. 'PTSD counseling' or 'job training'"),
          postal_code: POSTAL,
          city: str("City name (use with region)"),
          region: REGION,
          category: { type: "string", enum: categoryIds },
          specialty: { type: "string", enum: profile.specialties },
          radius_miles: num("Search radius in miles (default 50, max 200)", { maximum: 200 }),
          limit: num("Max results (default 10, max 50)", { maximum: 50 }),
        },
      },
      annotations: READ,
      run: async (env, a, ctx) => {
        const type = a.category ? profile.categories[a.category]?.upstream : undefined;
        const limit = Math.min(Number(a.limit) || 10, 50);
        let data;
        if (a.text) {
          data = await mcpCall(env, UP, "search_veteran_resources_by_text", { q: a.text, zip: a.postal_code, type, state: a.region, specialty: a.specialty, limit });
        } else if (a.postal_code) {
          data = await mcpCall(env, UP, "search_veteran_resources", { zip: a.postal_code, type: type || "all", specialty: a.specialty, radius: a.radius_miles || 50, limit });
        } else if (a.city) {
          data = await mcpCall(env, UP, "search_by_city", { city: a.city, state: a.region, type, radius: a.radius_miles || 50, limit });
        } else {
          throw new ToolError("Give text, postal_code or city.");
        }
        const records = normalizeResources(profile, data.resources || data.results || [], ctx.at);
        const where = a.postal_code || [a.city, a.region].filter(Boolean).join(", ") || "the search area";
        return {
          narration: `${records.length} ${records.length === 1 ? "result" : "results"} near ${where}${records.some((r) => r.flags.length) ? `; ${records.filter((r) => r.flags.length).length} carry quality flags to check` : ""}.`,
          total_available: data.total_within_radius ?? data.total ?? undefined,
          area: data.city ? { locality: data.city, region: data.state, county: data.county, rural: data.rural } : undefined,
          records,
          flag_counts: flagSummary(records),
          citations: [upstreamCitation(data)],
        };
      },
    },

    crisis_support: {
      title: "Crisis support",
      description: "Immediate crisis lines and the nearest crisis-capable services. Call this whenever someone mentions self-harm, suicide, hopelessness or crisis.",
      inputSchema: { type: "object", properties: { postal_code: POSTAL } },
      annotations: READ,
      run: async (env, a) => {
        const upstream = await mcpCall(env, UP, "veteran_crisis_resources", a.postal_code ? { zip: a.postal_code } : {}).catch(() => null);
        return {
          narration: `${profile.safety.lines[0].name}: ${profile.safety.lines[0].how}.`,
          safety: safetyBlock(profile),
          nearby: upstream ? normalizeResources(profile, upstream.nearest_crisis_resources || upstream.resources || []) : [],
          citations: upstream ? [upstreamCitation(upstream)] : [],
        };
      },
    },

    ask: {
      title: "Ask a question",
      description: "Conversational answer with crisis detection, intent and matching services. Use for open questions; use search_services for lists.",
      inputSchema: { type: "object", properties: { message: str("The question"), postal_code: POSTAL }, required: ["message"] },
      annotations: READ,
      run: async (env, a, ctx) => {
        const message = a.postal_code && !/\b\d{5}\b/.test(a.message) ? `${a.message} near ${a.postal_code}` : a.message;
        const data = await restPost(env, UP, "/api/chat", { message });
        const attribution = upstreamAttribution(data);
        const records = normalizeResources(profile, data.resources || [], ctx.at);
        return {
          narration: (data.message || "").split("\n")[0].slice(0, 200),
          answer: withoutSelfPromotion(data.message, attribution.publisher),
          intent: data.intent,
          is_crisis: Boolean(data.isCrisis),
          records,
          flag_counts: flagSummary(records),
          citations: [upstreamCitation(data)],
        };
      },
    },

    get_stats: {
      title: "Directory statistics",
      description: "Counts of services by category and region from each connected source, to understand scope before querying.",
      inputSchema: { type: "object", properties: { region: REGION } },
      annotations: READ,
      run: async (env, a) => {
        const data = await mcpCall(env, UP, "get_veteran_resource_stats", {});
        const byCategory = {};
        for (const [type, n] of Object.entries(data.by_type || {})) byCategory[categoryFor(profile, type)] = (byCategory[categoryFor(profile, type)] || 0) + n;
        const region = a.region?.toUpperCase();
        return {
          narration: region
            ? `${(data.by_state?.[region] || 0).toLocaleString("en-US")} services listed in ${region}.`
            : `${(data.total_resources || 0).toLocaleString("en-US")} services listed across ${data.states_covered} states and territories.`,
          total: data.total_resources,
          regions_covered: data.states_covered,
          by_category: byCategory,
          by_region: region ? { [region]: data.by_state?.[region] || 0 } : data.by_state,
          citations: [upstreamCitation(data)],
        };
      },
    },

    get_coverage: {
      title: "Coverage by county",
      description: "Services per county with coverage state. A county with no records is reported as 'unknown', not as having no services: absence of a record is not absence of a service.",
      inputSchema: { type: "object", properties: { region: REGION, limit: num("Max counties (default all)") }, required: ["region"] },
      annotations: READ,
      run: async (env, a) => {
        const region = a.region.toUpperCase();
        const data = await restGet(env, UP, "/api/coverage", { level: "county", state: region });
        let counties = (data.counties || []).map((c) => ({
          county_fips: c.fips_full, name: c.county_name, services: c.resource_count,
          completeness: c.avg_completeness, coverage: c.resource_count > 0 ? "observed" : "unknown",
        }));
        const toy = await toyCounties(env, region);
        if (toy.rows.length) {
          const listed = new Set(counties.map((c) => c.county_fips));
          for (const r of toy.rows) if (!listed.has(r.Fips)) counties.push({ county_fips: r.Fips, name: r.Name, services: 0, coverage: "unknown" });
          const pop = Object.fromEntries(toy.rows.map((r) => [r.Fips, Number(r.Population)]));
          counties = counties.map((c) => ({ ...c, population: pop[c.county_fips], services_per_10k: pop[c.county_fips] ? +(c.services / pop[c.county_fips] * 1e4).toFixed(2) : undefined }));
        }
        counties.sort((x, y) => (y.services || 0) - (x.services || 0));
        if (a.limit) counties = counties.slice(0, Number(a.limit));
        const unknown = counties.filter((c) => c.coverage === "unknown").length;
        return {
          narration: `${counties.length} counties in ${region}; ${unknown} with no records, to verify rather than count as zero.`,
          counties,
          citations: [upstreamCitation(data), ...(toy.rows.length ? [citation("census-pep-county")] : [])],
        };
      },
    },

    get_county_profile: {
      title: "County profile",
      description: "Industry levels (employees, establishments, payroll by NAICS sector), population and service counts for one county. Used to explain and forecast local service patterns.",
      inputSchema: { type: "object", properties: { county_fips: str("5-digit county FIPS, e.g. 13063", { pattern: "^\\d{5}$" }), year: num("Industry year (2017-2023, default 2023)") }, required: ["county_fips"] },
      annotations: READ,
      run: async (env, a) => {
        const fips = a.county_fips;
        const region = STATE_OF_FIPS[fips.slice(0, 2)];
        if (!region) throw new ToolError(`Unknown state FIPS in ${fips}`);
        const [industries, coverage, toy] = await Promise.all([
          communityIndustries(env, region, a.year || 2023).catch(() => ({})),
          restGet(env, UP, "/api/coverage", { level: "county", state: region }).catch(() => null),
          toyCounties(env, region),
        ]);
        const sectors = Object.entries(industries[fips] || {})
          .map(([code, v]) => ({ naics: code, name: NAICS2[code] || code, ...v }))
          .sort((x, y) => y.employees - x.employees);
        const cov = (coverage?.counties || []).find((c) => c.fips_full === fips);
        const row = toy.rows.find((r) => r.Fips === fips);
        const top = sectors[0];
        return {
          narration: `${row?.Name || cov?.county_name || fips}: ${cov?.resource_count ?? "no"} listed services${top ? `; largest employer sector is ${top.name}` : ""}.`,
          county_fips: fips,
          name: row?.Name || (cov ? `${cov.county_name} County` : undefined),
          region,
          population: row ? Number(row.Population) : undefined,
          services: cov?.resource_count ?? 0,
          service_completeness: cov?.avg_completeness,
          veteran_organizations_irs: row ? Number(row.VeteranOrgs) : undefined,
          industries: sectors,
          notes: "Sector values are rolled up from 4-digit NAICS, where withheld cells make them lower bounds.",
          citations: [citation("community-industries", { year: a.year || 2023 }), ...(coverage ? [upstreamCitation(coverage)] : []), ...(row ? [citation("irs-eo-bmf"), citation("census-pep-county")] : [])],
        };
      },
    },

    get_data_quality: {
      title: "Data quality",
      description: "Quality flags found by the goals pipeline (patterns that point to incorrect or missing data) and the upstream directory's own quality metrics.",
      inputSchema: { type: "object", properties: { scope: str("Pipeline scope, e.g. GA or AL-FL-GA-NC-SC-TN (default GA)") } },
      annotations: READ,
      run: async (env, a) => {
        const scope = a.scope || "GA";
        const prefix = env.DATA_PREFIX || "";
        const [local, upstream] = await Promise.all([
          assetText(env, `${prefix}/data/toy/${scope}/quality-summary.json`).then(JSON.parse).catch(() => null),
          restGet(env, UP, "/api/data/quality").catch(() => null),
        ]);
        return {
          narration: local ? `${local.records_flagged} of ${local.records} records in ${scope} carry at least one quality flag.` : "Upstream quality metrics only.",
          pipeline: local,
          upstream: upstream ? { total: upstream.total_resources, verification: upstream.verification, geocoding: upstream.geocoding, contact: upstream.contact_completeness, methodology: upstream.methodology } : null,
          citations: [...(local ? [citation("irs-eo-bmf"), citation("community-industries")] : []), ...(upstream ? [upstreamCitation(upstream)] : [])],
        };
      },
    },

    get_model_results: {
      title: "Forecast model results",
      description: "Which county industry levels best predict local veteran service density, with state-held-out cross-validation scores.",
      inputSchema: { type: "object", properties: { name: { type: "string", enum: ["naics2-veteran-services-southeast", "naics2-veteran-orgs-southeast"] } } },
      annotations: READ,
      run: async (env, a) => {
        const name = a.name || "naics2-veteran-services-southeast";
        const data = JSON.parse(await assetText(env, `${env.MODELS_PREFIX ?? "/project/models"}/results/${name}.json`));
        const xgb = (data.feature_importance?.xgboost || []).slice(0, 10);
        const cv = (data.cv?.results || []).map((r) => ({ model: r.model_type || r.Model || r.model, ...r }));
        return {
          narration: `Top predictor: ${xgb[0]?.Feature || "n/a"}.`,
          name, parameters: data.parameters, baseline: data.baseline, cross_validation: cv, top_features: xgb,
          citations: [citation("community-industries"), citation(UP)],
        };
      },
    },

    lookup_crosswalk: {
      title: "Crosswalk lookup",
      description: "Translate codes and fields between standards: naics-hs (traded products to industries), crm (fields to CRM tables), hsds (fields to Open Referral HSDS).",
      inputSchema: { type: "object", properties: { scheme: { type: "string", enum: ["naics-hs", "crm", "hsds"] }, code: str("NAICS or HS code, or a field/property name") }, required: ["scheme"] },
      annotations: READ,
      run: async (env, a) => {
        const prefix = env.DATA_PREFIX || "";
        let rows, src;
        if (a.scheme === "naics-hs") {
          const s = SOURCES["naics-hs-lookup"];
          const text = await assetText(env, s.local_path).catch(() => urlText(s.url_template));
          rows = parseCsv(text);
          src = citation("naics-hs-lookup");
          if (a.code) rows = rows.filter((r) => r["NAICS Code"].startsWith(a.code) || r["HS Code"].startsWith(a.code));
        } else {
          rows = parseCsv(await assetText(env, `${prefix}/schema/crosswalk-${a.scheme}.csv`));
          src = { source_id: `schema/crosswalk-${a.scheme}.csv`, title: `Goals ${a.scheme.toUpperCase()} crosswalk` };
          if (a.code) rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(a.code.toLowerCase())));
        }
        return { narration: `${rows.length} crosswalk rows.`, scheme: a.scheme, rows: rows.slice(0, 100), truncated: rows.length > 100, citations: [src] };
      },
    },

    list_sources: {
      title: "List sources",
      description: "Every source the goals tools draw on, with publisher, license, refresh cadence and use.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ,
      // Sources marked "listed": false in sources.json stay in use (and cited)
      // but are left out of this list.
      run: async () => {
        const listed = Object.values(SOURCES).filter((s) => s.listed !== false);
        return {
          narration: `${listed.length} sources registered.`,
          sources: listed.map(({ exclude_tools, env_override, listed: _, ...s }) => s),
          citations: [],
        };
      },
    },

    list_source_tools: {
      title: "List a source's tools",
      description: "Tools an upstream MCP source offers (excluding ones not relevant to this service).",
      inputSchema: { type: "object", properties: { source_id: { type: "string", enum: Object.values(SOURCES).filter((s) => s.mcp_url).map((s) => s.source_id) } }, required: ["source_id"] },
      annotations: READ,
      run: async (env, a) => {
        const tools = await mcpListTools(env, a.source_id);
        return { narration: `${tools.length} tools from ${a.source_id}.`, tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })), citations: [citation(a.source_id)] };
      },
    },

    call_source_tool: {
      title: "Call a source's tool",
      description: "Call any offered tool on an upstream MCP source directly, with its own argument names. Prefer the generic tools when one fits.",
      inputSchema: { type: "object", properties: { source_id: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, required: ["source_id", "tool"] },
      annotations: READ,
      run: async (env, a) => {
        if (!SOURCES[a.source_id]?.mcp_url) throw new ToolError(`${a.source_id} is not an MCP source`);
        const data = await mcpCall(env, a.source_id, a.tool, a.arguments || {});
        const { _meta, _provider, ...rest } = data || {};
        return { narration: `Called ${a.tool} on ${a.source_id}.`, result: rest, citations: [a.source_id === UP ? upstreamCitation(data) : citation(a.source_id)] };
      },
    },

    propose_correction: {
      title: "Propose a correction",
      description: "Report that a record is wrong or out of date. The correction enters a review queue as a candidate; it never changes data directly.",
      inputSchema: {
        type: "object",
        properties: {
          record_id: str("Record id from a search result"),
          property: str("Which property is wrong: name, address, phone, url, status, hours, category, ..."),
          proposed_value: { description: "The corrected value, if known" },
          evidence_url: str("Where the correction can be checked", { format: "uri" }),
          note: str("What is wrong"),
        },
        required: ["record_id", "property", "note"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async (env, a, ctx) => {
        const activity = {
          id: crypto.randomUUID(),
          crm_table: "activities",
          activity_type: "correction",
          status: "candidate",
          parent_id: a.record_id,
          property: a.property,
          proposed_value: a.proposed_value ?? null,
          evidence_url: a.evidence_url || null,
          note: String(a.note).slice(0, 2000),
          origin: ctx.client === "rest" ? "human_submitted" : "agent_submitted",
          created_at: ctx.at,
        };
        if (env.DB) {
          await env.DB.prepare(
            "INSERT INTO activities (id, activity_type, status, parent_id, property, proposed_value, evidence_url, note, origin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
          ).bind(activity.id, activity.activity_type, activity.status, activity.parent_id, activity.property,
            JSON.stringify(activity.proposed_value), activity.evidence_url, activity.note, activity.origin, activity.created_at).run();
        }
        return {
          narration: env.DB ? "Correction queued for human review." : "Correction prepared; no review queue is connected, so pass this activity to your CRM.",
          stored: Boolean(env.DB),
          activity,
          citations: [],
        };
      },
    },
  };

  // Upstream tools offered under generic names, with argument translation.
  for (const [name, spec] of Object.entries(profile.upstream.generic)) {
    if (T[name]) continue;
    const props = {};
    for (const generic of Object.values(spec.args)) {
      props[generic] = generic === "region" ? REGION : generic === "postal_code" ? POSTAL : { description: generic.replace(/_/g, " ") };
    }
    T[name] = {
      title: name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      description: `Reference lookup from the connected directory (${spec.tool}). Arguments: ${Object.values(spec.args).join(", ")}.`,
      inputSchema: { type: "object", properties: props },
      annotations: READ,
      run: async (env, a) => {
        const args = {};
        for (const [up, generic] of Object.entries(spec.args)) if (a[generic] !== undefined) args[up] = a[generic];
        const data = await mcpCall(env, profile.upstream.source_id, spec.tool, args);
        const { _meta, _provider, ...rest } = data || {};
        return { narration: `Result from ${name.replace(/_/g, " ")}.`, result: rest, citations: [upstreamCitation(data)] };
      },
    };
  }
  return T;
}

export class ToolError extends Error {}

// Runs a tool: safety check on text inputs first, then the handler, then the
// envelope. Errors come back as results with isError, per MCP.
export async function runTool(env, profile, tools, name, args = {}, client = "mcp") {
  const tool = tools[name];
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  const ctx = { at: now(), client };
  const text = [args.text, args.message, args.note].filter(Boolean).join(" ");
  const crisis = text && checkSafety(profile, text);
  const out = await tool.run(env, args, ctx);
  const envelope = { tool: name, generated_at: ctx.at, ...out };
  if (crisis && !envelope.safety) envelope.safety = safetyBlock(profile);
  return envelope;
}
