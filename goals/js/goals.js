// Project Goals page (project/goals/index.html): ask and search through the MCP
// server's REST routes, plus county, data-quality and forecast views. The data
// toggle switches between the sample files in data/toy and the live sources
// (community-data on GitHub, the directory API and MCP). #event=<id> loads
// ../events/<id>.yaml for the title and text; #event=next is Next Mission.

import { hbar, dotWhisker, scatter, spearman } from "./charts.js";
import { parseYamlLite } from "./yaml-lite.js";

// The goals Worker answers at /api/goals, mounted in a webroot (CloudRoot) or
// on its own. ?api= points the page at another deployment.
const params = new URLSearchParams(location.search);
const API = params.get("api") ?? "/api/goals";
const MODELS = "../models/results";
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");

const FLAG_TEXT = {
  name_only: "Veteran focus inferred from the name only; codes don't say so",
  ntee_missing: "Veterans post (IRS subsection 19) with no activity code",
  mailing_only: "Only a PO Box is listed: a mailing point, not a place to visit",
  zip_split: "The ZIP spans several counties, so the county is uncertain",
  zip_unmapped: "The ZIP has no Census match (often a PO Box ZIP)",
  no_filing_period: "No tax filing period on file",
  stale_filing: "Latest tax filing is more than three years old",
  duplicate_name_zip: "Several tax IDs share this name and ZIP",
  code_mismatch: "Veterans post coded outside the military and veterans group",
  state_mismatch: "The ZIP lies mainly in a different state than listed",
  rollup_shortfall: "4-digit industry cells add up to less than the 2-digit total (withheld cells)",
  source_missing_sectors: "A source file is missing whole industry sectors",
  industry_absent_sectors: "Industry sectors not published for the county: unknown, not zero",
  industry_high_noise: "Industry values carry high noise",
  orgs_without_sector81: "Veteran organizations on file, but no membership-organization establishments counted",
  directory_gap: "Directory lists nothing here, but IRS files hold veteran organizations",
  thin_records: "Many directory records here are missing contact or service details",
  no_records: "No records at all: a gap to verify, not a confirmed absence",
  placeholder_postal_code: "Postal code is a placeholder such as 00000",
  address_is_locality: "Street address is just the city or county name",
  no_contact: "No phone or website",
  shared_coordinates: "Shares map coordinates with other records (likely a centroid)",
  thin_record: "Few fields filled in",
};
const flagText = (f) => FLAG_TEXT[f] || f.replace(/_/g, " ");

async function api(path, body) {
  const res = await fetch(API + path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function local(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return path.endsWith(".csv") ? parseCsv(await res.text()) : res.json();
}
function parseCsv(text) {
  const [head, ...lines] = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const cols = head.split(",");
  // County summaries have no quoted commas except in Name; rejoin those.
  return lines.map((line) => {
    const parts = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((p) => p.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    return Object.fromEntries(cols.map((c, i) => [c, parts[i] ?? ""]));
  });
}
function node(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  n.append(...children.filter((c) => c != null));
  return n;
}

// --- Hash, event and data mode ---------------------------------------------------

// #event=next&tab=local&data=live&view=center. A bare #county (older links)
// is a tab. With localsite loaded, its getHash, goHashQuiet and hashChangeEvent
// are used (localsite/AGENTS.md), so manual edits to the URL are picked up too.
const hasLocalsiteHash = () => typeof getHash === "function";
function hashParams() {
  const h = location.hash.slice(1);
  if (h && !h.includes("=")) return { tab: h };
  return hasLocalsiteHash() ? getHash() : Object.fromEntries(new URLSearchParams(h));
}
// Records page state in the hash without firing a hash change.
function setHash(update) {
  const legacy = location.hash.length > 1 && !location.hash.includes("=");
  if (!legacy && typeof goHashQuiet === "function") {
    const add = {}, remove = [];
    for (const [k, v] of Object.entries(update)) if (v == null || v === "") remove.push(k); else add[k] = v;
    goHashQuiet(add, remove);
    return;
  }
  const next = { ...hashParams(), ...update };
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === "") delete next[k];
  const hash = new URLSearchParams(next).toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

const DEFAULTS = {};
let eventData = null;
async function loadEvent(id) {
  const res = await fetch(`../events/${id}.yaml`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} events/${id}.yaml`);
  const text = await res.text();
  return window.YAML?.parse ? window.YAML.parse(text) : parseYamlLite(text);
}
// "text [label](href) text": links limited to tel:, sms: and https:.
function linkedText(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\(((?:tel:|sms:|https:\/\/)[^)\s]+)\)/g)) {
    out.push(text.slice(last, m.index));
    const a = node("a", { href: m[2], text: m[1] });
    if (m[2].startsWith("https:")) { a.target = "_blank"; a.rel = "noopener"; }
    out.push(a);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
function renderTopinfo(ev) {
  const bar = $("topinfoBar");
  bar.hidden = !ev?.topinfo_text;
  if (bar.hidden) { bar.replaceChildren(); return; }
  bar.setAttribute("aria-label", ev.topinfo_label || "Information");
  bar.replaceChildren(...(ev.topinfo_label ? [node("strong", { text: ev.topinfo_label }), " "] : []), ...linkedText(String(ev.topinfo_text)));
}
async function applyEvent() {
  const id = (hashParams().event || "").replace(/[^a-zA-Z0-9_-]/g, "");
  eventData = null;
  if (id) {
    try { eventData = await loadEvent(id); } catch (err) { console.warn("[goals] event", id, err.message); }
  }
  renderTopinfo(eventData);
  const title = eventData?.mission_name || eventData?.label || DEFAULTS.title;
  $("goalsTitle").textContent = title;
  $("goalsEyebrow").textContent = eventData?.eyebrow || DEFAULTS.eyebrow;
  $("goalsLede").textContent = eventData?.lede || DEFAULTS.lede;
  document.title = eventData?.browser_title || title;
  setHeaderTitle(eventData?.headerTitle);
}

// headerTitle in an event's YAML replaces the localsite header logo with an
// earth icon and that title. The block has localsite's .showEarth class, so a
// click opens the Earth display the same way the Settings earth icon does
// (navigation.js). #headerLogo comes from localsite's template, so it's
// awaited with localsite's onElmReady (localsite/AGENTS.md). localsite then
// sets its logo inside it, so the whole header is watched and the title put
// back in the current #headerLogo whenever localsite rewrites it. With no
// headerTitle, localsite's logo returns.
let headerTitle = "", savedLogo = null, headerWatched = false;
function setHeaderTitle(title) {
  headerTitle = String(title || "").trim();
  console.info("[goals] headerTitle:", headerTitle || "(none)");
  // CSS hides localsite's #headerLocTitleHolder while the title is shown.
  document.documentElement.classList.toggle("goals-has-header-title", Boolean(headerTitle));
  if (!headerTitle && !savedLogo) return;
  if (typeof window.onElmReady !== "function") { console.warn("[goals] headerTitle skipped: localsite's onElmReady isn't loaded"); return; }
  window.onElmReady("#headerLogo", (logo) => {
    if (!headerWatched) {
      headerWatched = true;
      new MutationObserver(renderHeaderTitle).observe(logo.closest("#headerbar") || document.body, { childList: true, subtree: true });
    }
    renderHeaderTitle();
  });
}
function renderHeaderTitle() {
  const logo = document.getElementById("headerLogo");
  if (!logo) return;
  const ours = logo.querySelector(":scope > .goals-header-title");
  if (headerTitle) {
    if (ours) {
      if (ours.lastChild.textContent !== headerTitle) ours.lastChild.textContent = headerTitle;
      return;
    }
    savedLogo = { html: logo.innerHTML, bg: logo.style.backgroundImage };
    logo.style.backgroundImage = "none";
    logo.replaceChildren(node("div", { class: "showEarth goals-header-title", role: "button", tabindex: "0", title: "Show Earth" },
      node("i", { class: "material-icons", "aria-hidden": "true", text: "\ue894" }),
      node("span", { text: headerTitle })));
  } else if (ours) {
    logo.innerHTML = savedLogo?.html || "";
    logo.style.backgroundImage = savedLogo?.bg || "";
    savedLogo = null;
  }
}
// Enter or Space on the header title clicks it, as for a button. (The Earth map's scroll cover is
// localsite's, shared with other pages: initEarthScrollCover() in localsite.js.)
document.addEventListener("keydown", (e) => {
  const btn = e.target.closest?.(".goals-header-title");
  if ((e.key === "Enter" || e.key === " ") && btn) { e.preventDefault(); btn.click(); }
});

// view=hero (default): photos behind the page, faded to a random next one
// every 15 seconds. view=center: the centered layout, no photos.
const HERO_MS = 15000;
let heroList = [], heroTimer = null, heroShown = -1, heroLayer = 0, defaultHero = null;
function heroView() { return hashParams().view !== "center"; }
async function heroImages() {
  if (eventData?.hero_images?.length) return eventData.hero_images;
  if (hashParams().event) return [];
  // No event open: the Next Mission set is the default.
  if (!defaultHero) defaultHero = loadEvent("next").then((ev) => ev.hero_images || []).catch(() => []);
  return defaultHero;
}
function showHero(i) {
  const img = heroList[i];
  if (!img?.url) return;
  heroShown = i; // Now, so steps in a row go on from here before it loads
  const pre = new Image();
  pre.onload = () => {
    const layers = $("heroBg").querySelectorAll("img");
    // The first photo shows at once, without the fade from the page's color.
    const first = ![...layers].some((l) => l.classList.contains("on"));
    heroLayer = 1 - heroLayer;
    layers[heroLayer].src = img.url;
    $("heroBg").classList.toggle("goals-bg-instant", first);
    layers[heroLayer].classList.add("on");
    if (first) requestAnimationFrame(() => requestAnimationFrame(() => $("heroBg").classList.remove("goals-bg-instant")));
    layers[1 - heroLayer].classList.remove("on");
    const credit = $("heroCredit");
    credit.replaceChildren();
    if (img.credit) credit.append("Photo: ", img.link ? node("a", { href: img.link, target: "_blank", rel: "noopener", text: img.credit }) : img.credit, " / Unsplash");
  };
  pre.src = img.url;
}
function nextHero() {
  if (document.hidden || heroList.length < 2) return;
  let i = heroShown;
  while (i === heroShown) i = Math.floor(Math.random() * heroList.length);
  showHero(i);
}
// #fullscreen holds the photos and, once localsite's .showEarth opens it, the
// Earth map (#mainEarthDisplay) over them. While it or another layer covers
// them, the photos stop changing, and the play button is the map's. The voice
// widget's canvas and words (claude-voice-*, engine/claude-voice.js) don't count.
function heroCovered() {
  return [...$("fullscreen").children].some((el) => el.id !== "heroBg" && el.id !== "earthPlayPauseButton" && !/\bclaude-voice-/.test(el.getAttribute("class") || "") && !el.hidden && el.style.display !== "none" && getComputedStyle(el).display !== "none");
}
function syncHero() {
  const covered = heroCovered();
  $("fullscreen").classList.toggle("goals-hero-covered", covered);
  const run = heroView() && !covered && heroList.length > 1;
  if (run && !heroTimer) heroTimer = setInterval(nextHero, HERO_MS);
  else if (!run && heroTimer) { clearInterval(heroTimer); heroTimer = null; }
  const btn = $("earthPlayPauseButton");
  const playing = btn.querySelector(".play-pause-icon")?.textContent === "pause";
  const label = !covered ? "Next photo" : playing ? "Pause map playback" : "Play map playback"; // localsite's labels for the map
  if (btn.title !== label) { btn.title = label; btn.setAttribute("aria-label", label); }
}
// Over the photos, the play button shows the next one and turns on the left
// and right arrow keys for stepping through them. Over the map, the click goes
// on to localsite's play/pause for it (nouislider.min.js).
let heroKeys = false;
function stepHero(by) {
  if (heroList.length < 2) return;
  showHero((Math.max(0, heroShown) + by + heroList.length) % heroList.length);
  clearInterval(heroTimer); // A full HERO_MS before the next change
  heroTimer = null;
  syncHero();
}
function heroButton(e) {
  if (!e.target.closest?.("#earthPlayPauseButton") || !heroView() || heroCovered()) return;
  if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.stopPropagation(); // Captured on document, so localsite's listeners on the button don't run
  heroKeys = true;
  stepHero(1);
}
function heroArrowKeys(e) {
  if (!heroKeys || (e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!heroView() || heroCovered() || e.target.closest?.('input, textarea, select, [contenteditable], [role="tablist"]')) return;
  e.preventDefault();
  stepHero(e.key === "ArrowRight" ? 1 : -1);
}
// How far #goalsPage starts below the top of the page, as --header-h for
// --fullscreen-height (goals.css), the min-heights that keep the footer below
// the fold. Rechecked when the page resizes.
function fitPageHeight() {
  const g = $("goalsPage");
  const top = Math.max(0, Math.round(g.getBoundingClientRect().top + window.scrollY));
  const root = document.documentElement;
  if (root.style.getPropertyValue("--header-h") !== `${top}px`) root.style.setProperty("--header-h", `${top}px`);
}

async function applyView() {
  const hero = heroView();
  document.documentElement.classList.toggle("goals-view-hero", hero);
  alignAside();
  fitPageHeight();
  clearInterval(heroTimer);
  heroTimer = null;
  if (!hero) { syncHero(); return; }
  const list = await heroImages();
  if (list !== heroList) { heroList = list; heroShown = -1; }
  if (!heroList.length) { for (const l of $("heroBg").querySelectorAll("img")) l.classList.remove("on"); $("heroCredit").replaceChildren(); return; }
  if (heroShown < 0) showHero(Math.floor(Math.random() * heroList.length));
  syncHero();
}

// Sample: files in data/toy (no network beyond this site). Live: the sources
// in pipeline/sources.json, fetched from the browser (both allow any origin).
let dataMode = "sample";
let sourceList = null;
async function sources() {
  if (!sourceList) sourceList = (await local("pipeline/sources.json")).sources;
  return sourceList;
}
async function source(id) {
  const s = (await sources()).find((x) => x.source_id === id);
  if (!s) throw new Error(`No source ${id} in pipeline/sources.json`);
  return s;
}
const liveCache = new Map();
function cached(key, load) {
  if (!liveCache.has(key)) liveCache.set(key, load().catch((err) => { liveCache.delete(key); throw err; }));
  return liveCache.get(key);
}
async function directoryCoverage(state) {
  const base = (await source("upstream-directory")).api_url.replace(/\/$/, "");
  return cached(`coverage-${state}`, async () => {
    const res = await fetch(`${base}/api/coverage?level=county&state=${state}`);
    if (!res.ok) throw new Error(`Directory API ${res.status}`);
    return res.json();
  });
}
async function communityIndustries(state, year) {
  const tpl = (await source("community-industries")).url_template;
  const url = tpl.replaceAll("{state}", state).replace("{level}", "2").replace("{year}", year);
  return cached(url, async () => ({ url, rows: await local(url) }));
}
const industryYear = () => Number(eventData?.data?.industry_year) || 2023;
const sampleScope = () => eventData?.data?.sample_scope || "AL-FL-GA-NC-SC-TN";

const MODE_NOTE = {
  sample: "Toy Data: files in data/toy, made by pipeline/county_pipeline.py. Ask always uses the live directory.",
  live: "Live Data: community-data on GitHub and the directory API, fetched now. Population and IRS counts come from the pipeline.",
};
function setDataMode(mode, redraw = true) {
  dataMode = mode === "live" ? "live" : "sample";
  for (const sel of document.querySelectorAll("select[data-source]")) { sel.value = dataMode; sel.title = MODE_NOTE[dataMode]; }
  if (!redraw) return;
  if (drawn.has("local")) { drawCounty(); drawAgreement(); }
  if (drawn.has("quality")) drawQualityView();
}

// The last ZIP the person typed, restored on reload. Example chips fill their
// own ZIP without replacing it.
const ZIP_KEY = "goals.postal_code";
function savedZip() {
  try { return localStorage.getItem(ZIP_KEY) || ""; } catch { return ""; }
}
function saveZip(zip) {
  try { if (/^\d{5}$/.test(zip)) localStorage.setItem(ZIP_KEY, zip); else if (!zip) localStorage.removeItem(ZIP_KEY); } catch { /* storage blocked */ }
}

// --- Ask and search ----------------------------------------------------------

function renderSafety(safety) {
  const box = $("safety");
  box.replaceChildren();
  box.hidden = !safety;
  if (!safety) return;
  box.append(node("strong", { text: safety.message }));
  const ul = node("ul");
  for (const l of safety.lines) {
    const href = l.channel === "phone" ? `tel:${l.value}` : l.channel === "sms" ? `sms:${l.value}` : l.value;
    ul.append(node("li", {}, node("a", { href, text: l.name }), ` — ${l.how}`));
  }
  box.append(ul);
}

function renderCitations(target, citations = []) {
  target.replaceChildren();
  if (!citations.length) return;
  target.append("Sources: ");
  citations.forEach((c, i) => {
    if (i) target.append(" · ");
    const label = [c.publisher || c.title || c.source_id, c.license].filter(Boolean).join(", ");
    target.append(c.url ? node("a", { href: c.url, target: "_blank", rel: "noopener", text: label }) : label);
  });
}

function card(r) {
  const meta = [r.address?.street, r.address?.locality, r.address?.region, r.address?.postal_code].filter(Boolean).join(", ");
  const flags = node("div", { class: "goals-flags" });
  if (!r.flags.length) flags.append(node("span", { class: "goals-flag ok", text: "No flags" }));
  for (const f of r.flags) flags.append(node("span", { class: "goals-flag", title: flagText(f), text: f.replace(/_/g, " ") }));
  const links = node("div", { class: "goals-meta" });
  if (r.phone) links.append(node("a", { href: `tel:${r.phone.replace(/[^\d+]/g, "")}`, text: r.phone }));
  if (r.url) { if (r.phone) links.append(" · "); links.append(node("a", { href: r.url, target: "_blank", rel: "noopener", text: "Website" })); }
  const report = node("button", { type: "button", text: "Report a problem" });
  report.addEventListener("click", () => openCorrection(r));
  return node("article", { class: "goals-card" },
    node("span", { class: "goals-cat", text: [r.category_label || r.category, r.distance_miles != null ? `${r.distance_miles} mi` : null].filter(Boolean).join(" · ") }),
    node("h3", { text: r.name }),
    meta ? node("div", { class: "goals-meta", text: meta }) : null,
    links.childNodes.length ? links : null,
    flags,
    node("div", { class: "goals-actions" }, report, ` · ${r.review_state}`),
  );
}

function renderResults(data) {
  $("results").hidden = false;
  renderSafety(data.safety);
  $("answer").textContent = data.answer || "";
  const recs = data.records || [];
  $("records").replaceChildren(...recs.map(card));
  const flagged = recs.filter((r) => r.flags.length).length;
  $("flagSummary").textContent = recs.length
    ? `${recs.length} results${data.total_available ? ` of ${nf.format(data.total_available)}` : ""}. ${flagged} carry quality flags; hover a flag for what it means. Confirm details with the provider.`
    : "No matching services. Try a nearby ZIP or broader words.";
  renderCitations($("resultCites"), data.citations);
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function busy(on) {
  for (const b of document.querySelectorAll("#askForm button")) b.disabled = on;
  if (on) { $("results").hidden = false; $("answer").textContent = "Working…"; $("records").replaceChildren(); $("flagSummary").textContent = ""; }
}

async function ask(evt) {
  evt?.preventDefault();
  const message = $("askText").value.trim();
  if (!message) return;
  busy(true);
  try {
    renderResults(await api("/ask", { message, postal_code: $("askZip").value || undefined }));
  } catch (err) {
    $("answer").textContent = `Couldn't reach the service: ${err.message}`;
  } finally { busy(false); }
}

async function listServices() {
  const q = new URLSearchParams();
  const text = $("askText").value.trim();
  if (text) q.set("text", text);
  if ($("askZip").value) q.set("postal_code", $("askZip").value);
  if ($("askCategory").value) q.set("category", $("askCategory").value);
  if (!text && !$("askZip").value) { $("askZip").focus(); return; }
  q.set("limit", "12");
  busy(true);
  try {
    const data = dataMode === "sample" ? await sampleSearch(text, $("askZip").value, $("askCategory").value) : await api(`/tools/search_services?${q}`);
    data.answer = data.narration;
    renderResults(data);
  } catch (err) {
    $("answer").textContent = `Couldn't reach the service: ${err.message}`;
  } finally { busy(false); }
}

// Sample search: the IRS-derived records in data/toy/records-<ST>-sample.json.
const SAMPLE_STATES = ["AL", "FL", "GA", "NC", "SC", "TN"];
async function sampleSearch(text, zip, category) {
  const files = await Promise.all(SAMPLE_STATES.map((st) => local(`data/toy/records-${st}-sample.json`).catch(() => ({ records: [] }))));
  const claim = (r, prop) => r.claims?.find((c) => c.property === prop)?.value;
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const recs = files.flatMap((f) => f.records).map((r) => ({
    ...r, address: claim(r, "address") || { region: r.region, postal_code: r.postal_code },
    phone: claim(r, "phone"), url: claim(r, "url"),
  })).filter((r) => (!zip || String(r.postal_code || "").startsWith(zip.slice(0, 3)))
    && (!category || r.category === category)
    && (!words.length || words.some((w) => `${r.name} ${r.category}`.toLowerCase().includes(w))));
  recs.sort((a, b) => (b.postal_code === zip) - (a.postal_code === zip));
  return {
    narration: `${recs.length} toy records match (IRS-coded veteran organizations, a few per quality flag). Switch to Live Data for the full directory.`,
    records: recs.slice(0, 12), total_available: recs.length,
    citations: [{ source_id: "data/toy", title: "Toy Data in data/toy" }],
  };
}

async function openCorrection(r) {
  const note = window.prompt(`What's wrong with "${r.name}"? (Goes to a review queue, not straight into the data.)`);
  if (!note) return;
  try {
    const res = await api("/tools/propose_correction", { record_id: r.id, property: "general", note });
    console.log("[goals] correction", res);
    $("flagSummary").textContent = res.narration;
  } catch (err) {
    $("flagSummary").textContent = `Correction not sent: ${err.message}`;
  }
}

// --- Tabs and objectives -------------------------------------------------------

// "goals" (the hero and ask results) is the first tab and the default. Its
// button writes tab=goals, and a second click removes tab= from the hash,
// which drops the column to the bottom (syncMainDrop). CSS hides the hero on
// the other tabs.
const drawn = new Set();
const TAB_ALIASES = { developers: "agents", objectives: "data", services: "data", proposal: "plan", county: "local", jobs: "local", forecast: "analytics", trends: "analytics", reality: "analytics", analytis: "analytics" }; // older links
const tabName = (t) => {
  t = TAB_ALIASES[t] || t;
  return t && document.querySelector(`.goals-tabs [data-tab="${t}"]`) ? t : "goals";
};
// With no tab= in the hash, the goals panel shows but no tab is highlighted. None is while
// the Earth map filters show in #earthFilterCatch (initFilterCatch), and the selected one is
// highlighted again once they close.
let markedTab = "";
function markButtons(selected) {
  markedTab = selected;
  const caught = $("goalsPage").classList.contains("goals-filters-caught");
  for (const b of document.querySelectorAll(".goals-tabs button[data-tab]")) b.setAttribute("aria-selected", String(!caught && b.dataset.tab === selected));
}

// #earthFilterCatch, after the tabs, holds localsite's Earth map filters panel
// (#mainEarthFilters), which earth-filters.js moves into it whenever it places the panel.
// While the panel shows there, the column is the filters': no tab is highlighted and the
// tabs' content hides (goals-filters-caught, goals.css). A tab closes the panel.
function initFilterCatch() {
  const filterCatch = node("div", { id: "earthFilterCatch", hidden: "" });
  document.querySelector(".goals-tabs").after(filterCatch);
  const sync = () => {
    const panel = $("mainEarthFilters");
    const shown = !!panel && panel.parentElement === filterCatch && !panel.classList.contains("ef-closed") && panel.style.display !== "none";
    filterCatch.hidden = !shown;
    if (shown !== $("goalsPage").classList.contains("goals-filters-caught")) {
      $("goalsPage").classList.toggle("goals-filters-caught", shown);
      markButtons(markedTab);
    }
  };
  new MutationObserver(sync).observe(filterCatch, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  window.mainEarthFilters?.applyMapPanelPlace?.(); // A panel placed before the catch was here
  sync();
}
// The tune circle (localsite.js) closes the panel when it opened it, which also clears its
// .earthControlsOpen. Otherwise the panel closes on its own.
function closeEarthFilters() {
  if ($("earthFilterCatch")?.hidden !== false) return;
  const toggle = $("earthControlsToggle");
  if (toggle?.getAttribute("aria-expanded") === "true") toggle.click();
  else window.mainEarthFilters?.setMapPanelOpen?.(false);
}
function markTab(name, selected = name) {
  markButtons(selected);
  for (const p of document.querySelectorAll(".goals-panel")) p.hidden = p.dataset.panel !== name;
  $("goalsMain").dataset.tab = name;
  placeSides();
}

// On wide windows the active panel's side column (figures) moves into
// #goalsAside, to the right of #goalsMain, lined up with the panel's top. One
// marked goals-side-bottom moves into #goalsBottom, across the bottom, at any
// width. Otherwise a side column stays at the end of its panel. Moving keeps
// listeners and ids.
const WIDE = window.matchMedia("(min-width: 901px)");
const sideHome = new Map();
function placeSides() {
  const aside = $("goalsAside"), bottom = $("goalsBottom");
  const tab = $("goalsMain").dataset.tab;
  for (const side of document.querySelectorAll(".goals-side")) {
    if (!sideHome.has(side)) sideHome.set(side, side.parentElement);
    const home = sideHome.get(side);
    const dest = home.closest(".goals-panel").dataset.panel !== tab ? home
      : side.classList.contains("goals-side-bottom") ? bottom
      : WIDE.matches ? aside : home;
    if (side.parentElement !== dest) dest.append(side);
  }
  aside.hidden = !aside.children.length;
  bottom.hidden = !bottom.children.length;
  $("goalsPage").classList.toggle("goals-with-aside", !aside.hidden);
  $("goalsPage").classList.toggle("goals-with-bottom", !bottom.hidden);
  alignAside();
}
// The top 10px of the tabs bar (.goals-grip, unmarked) drags #goalsMain down the window,
// as far as the tabs reaching its bottom edge, to see the photo behind. On the
// Goals tab it also drags up, through the spare space above the tabs on a tall
// window (mainDropMin), a negative --main-drop. The top info line stays in place
// (CSS moves the other children by --main-drop). A double-click on the strip
// brings it back. A click that doesn't move passes to the tab beneath. Mouse
// and touch only: the column's content is all reachable without moving it.
let mainDrop = 0;
function setMainDrop(px, animate = false) {
  mainDrop = Math.max(mainDropMin(), Math.round(px));
  const main = $("goalsMain");
  main.classList.toggle("goals-main-settle", animate);
  main.style.setProperty("--main-drop", `${mainDrop}px`);
  $("goalsPage").classList.toggle("goals-main-dropped", mainDrop > 0);
  $("goalsPage").classList.toggle("goals-main-raised", mainDrop < 0);
  const arrow = $("goalsMainArrow");
  if (arrow) {
    const label = mainDrop > 0 ? "Move this column up" : "Move this column down";
    arrow.title = label;
    arrow.setAttribute("aria-label", label);
  }
}
function initMainGrip() {
  const tabs = document.querySelector(".goals-tabs");
  const grip = node("div", { class: "goals-grip", "aria-hidden": "true", title: "Drag to move this column down, or up on the Goals tab. Double-click to bring it back." });
  tabs.prepend(grip);
  // Triangle at the far right, after the tabs' column: points up while the column is down and
  // raises it, then points down (CSS turns it) and docks it again.
  const arrow = node("button", { type: "button", id: "goalsMainArrow", class: "goals-main-arrow" },
    node("span", { "aria-hidden": "true", text: "\u25B2" }));
  tabs.append(arrow);
  arrow.addEventListener("click", () => { mainDocked = mainDrop <= 0; setMainDrop(mainDrop > 0 ? 0 : dockDrop(), true); });
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY, start = mainDrop;
    const max = Math.max(start, start + window.innerHeight - tabs.getBoundingClientRect().bottom);
    let moved = false;
    const move = (ev) => {
      if (Math.abs(ev.clientY - startY) > 3) moved = true;
      if (moved) { mainDocked = false; setMainDrop(Math.min(max, start + ev.clientY - startY)); }
    };
    const end = (ev) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (moved || ev.type !== "pointerup") return;
      grip.style.pointerEvents = "none";
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      grip.style.pointerEvents = "";
      under?.closest(".goals-tabs button")?.click(); // A tab or the up/down arrow
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  });
  grip.addEventListener("dblclick", () => { mainDocked = false; setMainDrop(0, true); });
}
// With no tab= in the hash, the column starts down: its tabs MAIN_DOCK px
// above the window's bottom, the photo above them. Any tab= brings it back to
// its usual place. It's placed again when tab= changes, and on resize while
// it's docked with no tab=, so a manual drag or the arrow's raise stays put
// through other hash changes (earth=, data=) and resizes.
const MAIN_DOCK = 89;
let dropTab = null; // The hash's tab= when the column was last placed
let mainDocked = false; // At the docked place, not moved by a drag or the arrow
function syncMainDrop(animate = false, refit = false) {
  const t = hashParams().tab || "";
  if (t === dropTab && !(refit && !t && mainDocked)) return;
  dropTab = t;
  mainDocked = !t;
  setMainDrop(t ? 0 : dockDrop(), animate);
}
// The drop that puts the tabs MAIN_DOCK px above the window's bottom. The
// tabs' place without the drop is their place now less the translateY they
// have now, which mid-slide isn't mainDrop yet.
function dockDrop() {
  const tabsTop = tabsPlace().top + window.scrollY;
  return window.innerHeight - MAIN_DOCK - tabsTop;
}
// The tabs' rect in the window without the drop: their place now less the translateY they have now.
function tabsPlace() {
  const tabs = document.querySelector(".goals-tabs");
  const transform = getComputedStyle(tabs).transform;
  const shift = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
  const rect = tabs.getBoundingClientRect();
  return { top: rect.top - shift, bottom: rect.bottom - shift };
}
// How far up the column can go: on the Goals tab, the spare space above the tabs, up to the top info line
// (and its margin) when it shows, or the column's top. Elsewhere, not above its place.
function mainDropMin() {
  const main = $("goalsMain");
  if (main.dataset.tab !== "goals") return 0;
  const topinfo = $("topinfoBar");
  const limit = topinfo && !topinfo.hidden
    ? topinfo.getBoundingClientRect().bottom + parseFloat(getComputedStyle(topinfo).marginBottom)
    : main.getBoundingClientRect().top;
  return Math.min(0, Math.round(limit - tabsPlace().top));
}
function alignAside() {
  const aside = $("goalsAside");
  if (aside.hidden) return;
  const panel = document.querySelector(`.goals-panel[data-panel="${$("goalsMain").dataset.tab}"]`);
  const top = `${Math.max(0, Math.round(panel.getBoundingClientRect().top - $("goalsMain").getBoundingClientRect().top))}px`;
  if (aside.style.getPropertyValue("--aside-top") !== top) aside.style.setProperty("--aside-top", top);
}
// hashTab is what goes in tab=: the tab's name by default, "" to leave it out.
function showTab(name, hashTab = name) {
  markTab(name, hashTab ? name : "");
  setHash({ tab: hashTab });
  syncMainDrop(true);
  if (!drawn.has(name)) { drawn.add(name); ({ data: initSources, local: initCounty, quality: drawQuality, analytics: drawForecast, agents: initDevelopers, plan: initPlan }[name] || (() => {}))(); }
}

const OBJECTIVES = [
  { title: "Extract and Integrate", text: "AI-assisted feature extraction and metadata across hundreds of state, federal and international datasets, joined to health and job services, cleaned for accuracy and timeliness.", action: "Data Quality Control", tab: "quality" },
  { title: "Pipeline Automation", text: "Agentic processes add a layer of safety and accuracy when automating form processes and connecting to enriching activities, with analytics open for interdisciplinary research.", action: "Community Analytics", tab: "analytics" },
  { title: "Harmonized AI Data", text: "Open schemas harmonize industry databases and community services: automated site-to-site interactions over MCP, social media and hands-on field incentives in building, design and logistics.", action: "Agent Orchestration", tab: "agents" },
];
function initObjectives() {
  $("objectives").replaceChildren(...OBJECTIVES.map((o, i) => {
    const b = node("button", { type: "button", text: `${o.action} →` });
    b.addEventListener("click", () => showTab(o.tab));
    return node("article", { class: "goals-objective" }, node("div", { class: "goals-objective-head" }, node("div", { class: "goals-objective-num" }, node("span", { class: "goals-sr", text: "Objective " }), String(i + 1)), node("h3", { text: o.title })), node("p", { text: o.text }), b);
  }));
}

// Data Services tab: the first SOURCES_SHOWN sources from list_sources, then a
// "More Data Sources" link that shows the rest (and reads "Less" while open).
const SOURCES_SHOWN = 3;
async function initSources() {
  const box = $("sourcesList");
  try {
    const { sources } = await api("/tools/list_sources");
    const items = sources.map((s, i) => {
      const li = node("li", {}, node("strong", { text: s.title }), ` — ${s.used_for}. ${s.license || ""}`);
      li.hidden = i >= SOURCES_SHOWN;
      return li;
    });
    const list = node("ul", { id: "sourcesItems" }, ...items);
    box.replaceChildren(list);
    if (sources.length <= SOURCES_SHOWN) return;
    const more = node("a", { href: "#", id: "sourcesLink", "aria-controls": "sourcesItems", "aria-expanded": "false", text: "More Data Sources" });
    more.addEventListener("click", (e) => {
      e.preventDefault();
      const open = more.getAttribute("aria-expanded") !== "true";
      items.slice(SOURCES_SHOWN).forEach((li) => { li.hidden = !open; });
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "Less" : "More Data Sources";
    });
    box.append(node("p", { class: "goals-sources-more" }, more));
  } catch (err) { box.textContent = err.message; }
}

// --- Local Jobs Engine (tab=local) -------------------------------------------------

let counties = [];
let features = new Map();
async function initCounty() {
  try {
    counties = await local(`data/toy/${sampleScope()}/county-summary.csv`);
    for (const r of await local(`data/toy/${sampleScope()}/county-features.csv`)) features.set(r.Fips, r);
  } catch (err) {
    $("countyStats").textContent = `County data unavailable (${err.message}).`;
    return;
  }
  const states = [...new Set(counties.map((c) => c.Region))].sort();
  $("countyState").replaceChildren(...states.map((s) => node("option", { value: s, text: s })));
  $("countyState").value = states.includes("GA") ? "GA" : states[0];
  $("countyState").addEventListener("change", () => { fillCounties(); drawAgreement(); });
  $("countyPick").addEventListener("change", drawCounty);
  fillCounties();
  drawAgreement();
}
function fillCounties() {
  const st = $("countyState").value;
  const list = counties.filter((c) => c.Region === st).sort((a, b) => a.Name.localeCompare(b.Name));
  $("countyPick").replaceChildren(...list.map((c) => node("option", { value: c.Fips, text: c.Name })));
  const clayton = list.find((c) => c.Fips === "13063");
  $("countyPick").value = clayton ? clayton.Fips : list[0]?.Fips;
  drawCounty();
}
function stat(value, label) { return node("div", { class: "goals-stat" }, node("div", { class: "v", text: value }), node("div", { class: "l", text: label })); }

const SECTORS = {
  11: "Agriculture, Forestry, Fishing and Hunting", 21: "Mining, Quarrying, and Oil and Gas Extraction", 22: "Utilities",
  23: "Construction", 31: "Manufacturing", 42: "Wholesale Trade", 44: "Retail Trade", 48: "Transportation and Warehousing",
  51: "Information", 52: "Finance and Insurance", 53: "Real Estate and Rental and Leasing",
  54: "Professional, Scientific, and Technical Services", 55: "Management of Companies and Enterprises",
  56: "Administrative and Support and Waste Management", 61: "Educational Services", 62: "Health Care and Social Assistance",
  71: "Arts, Entertainment, and Recreation", 72: "Accommodation and Food Services",
  81: "Other Services (except Public Administration)", 92: "Public Administration", 99: "Unclassified",
};
// [{ code, name, employees, establishments, payroll }] for one county.
function sampleIndustries(fips) {
  const row = features.get(fips) || {};
  return Object.keys(SECTORS).filter((c) => `Emp-${c}` in row).map((c) => ({
    code: c, name: SECTORS[c], employees: +row[`Emp-${c}`] || 0, establishments: +row[`Est-${c}`] || 0, payroll: +row[`Pay-${c}`] || 0,
  }));
}
async function liveIndustries(state, fips) {
  const { url, rows } = await communityIndustries(state, industryYear());
  return {
    url,
    sectors: rows.filter((r) => r.Fips.padStart(5, "0") === fips && SECTORS[r.Naics]).map((r) => ({
      code: r.Naics, name: SECTORS[r.Naics], employees: +r.Employees || 0, establishments: +r.Establishments || 0, payroll: +r.Payroll || 0,
    })),
  };
}
function sourceNote(target, parts) {
  target.replaceChildren("Source: ");
  parts.forEach(([label, href], i) => {
    if (i) target.append(" · ");
    target.append(href ? node("a", { href, target: "_blank", rel: "noopener", text: label }) : label);
  });
}

async function drawCounty() {
  const fips = $("countyPick").value;
  const st = $("countyState").value;
  const row = counties.find((c) => c.Fips === fips) || {};
  const mode = dataMode;
  let services = row.Services || "0";
  if (mode === "live") {
    try {
      const cov = await directoryCoverage(st);
      const c = (cov.counties || []).find((x) => String(x.fips_full).padStart(5, "0") === fips);
      services = String(c?.resource_count ?? 0);
    } catch (err) { services = "?"; }
  }
  $("countyStats").replaceChildren(
    stat(nf.format(+row.Population || 0), "residents (2024)"),
    stat(services, mode === "live" ? "directory services (live)" : "directory services"),
    stat(row.VeteranOrgs || "0", "IRS-coded veteran orgs"),
    stat(row.Coverage === "unknown" ? "Unknown" : "Observed", "coverage"),
  );
  $("countyChart").textContent = "Loading industries…";
  try {
    let sectors, note;
    if (mode === "live") {
      const live = await liveIndustries(st, fips);
      sectors = live.sectors;
      note = [[`community-data, County Business Patterns ${industryYear()}`, live.url], ["directory API", null]];
    } else {
      sectors = sampleIndustries(fips);
      note = [[`data/toy/${sampleScope()}/county-features.csv (County Business Patterns ${industryYear()})`, `data/toy/${sampleScope()}/county-features.csv`]];
    }
    if (mode !== dataMode) return;
    sectors.sort((a, b) => b.employees - a.employees);
    hbar($("countyChart"), sectors.filter((s) => s.employees > 0).slice(0, 12).map((s) => ({
      label: s.name, value: s.employees, note: `${nf.format(s.establishments)} establishments · $${nf.format(s.payroll)}K payroll`,
    })));
    sourceNote($("countySource"), note);
  } catch (err) {
    $("countyChart").textContent = `Industry data unavailable (${err.message}).`;
  }
}
async function drawAgreement() {
  const mode = dataMode;
  let live = null;
  if (mode === "live") {
    live = new Map();
    try {
      const states = [...new Set(counties.map((c) => c.Region))];
      for (const cov of await Promise.all(states.map(directoryCoverage))) {
        for (const c of cov.counties || []) live.set(String(c.fips_full).padStart(5, "0"), +c.resource_count || 0);
      }
    } catch (err) { live = null; }
    if (mode !== dataMode) return;
  }
  const perTenK = (c) => (live ? ((live.get(c.Fips) || 0) / (+c.Population || 1)) * 1e4 : +c.ServicesPer10k);
  const pts = counties.filter((c) => (live ? +c.Population > 0 : c.Services !== "")).map((c) => ({ x: perTenK(c), y: +c.OrgsPer10k, label: `${c.Name}, ${c.Region}`, group: c.Region }));
  scatter($("agreeChart"), pts, { xLabel: "Directory services per 10k", yLabel: "IRS veteran orgs per 10k", highlight: $("countyState").value });
  const rho = spearman(pts.map((p) => p.x), pts.map((p) => p.y));
  $("agreeNote").textContent = `Across ${pts.length} counties the two sources barely agree on where services are (Spearman ρ = ${rho.toFixed(2)}). ${$("countyState").value} is highlighted; square-root axes.`;
}

// --- Data quality -------------------------------------------------------------------

async function drawQuality() {
  $("qualityScope").addEventListener("change", drawQualityView);
  await drawQualityView();
}
async function drawQualityView() {
  const live = dataMode === "live";
  $("qualityScopeLabel").hidden = live;
  $("qualityCaption").textContent = live ? "Directory records with each quality signal (share of all records, live)" : "Quality flags raised by the pipeline";
  try {
    if (live) {
      const base = (await source("upstream-directory")).api_url.replace(/\/$/, "");
      const q = await cached("quality", async () => {
        const res = await fetch(`${base}/api/data/quality`);
        if (!res.ok) throw new Error(`Directory API ${res.status}`);
        return res.json();
      });
      if (dataMode !== "live") return;
      const v = q.verification || {}, g = q.geocoding || {}, c = q.contact_completeness || {};
      $("qualityStats").replaceChildren(
        stat(nf.format(q.total_resources || 0), "directory records"),
        stat(`${v.source_backed_pct ?? "?"}%`, "backed by a source"),
        stat(`${v.stale_over_90d_pct ?? "?"}%`, "not checked in 90 days"),
        stat(`${g.with_fips_pct ?? "?"}%`, "placed in a county"),
      );
      hbar($("qualityChart"), [
        { label: "Backed by a source", value: v.source_backed_pct },
        { label: "Placed in a county", value: g.with_fips_pct },
        { label: "Has a phone number", value: c.with_phone_pct },
        { label: "Not checked in 90 days", value: v.stale_over_90d_pct },
        { label: "Has a website", value: c.with_website_pct },
        { label: "Has an email address", value: c.with_email_pct },
      ].filter((r) => Number.isFinite(r.value)), { format: (x) => String(x), unit: "%" });
      $("flagDefs").replaceChildren(node("dt", { text: "Live metrics" }), node("dd", { text: q.methodology ? String(q.methodology).slice(0, 400) : "Reported by the directory API." }));
      sourceNote($("qualitySource"), [[`directory API, generated ${String(q.generated_at || "").slice(0, 10)}`, null]]);
      return;
    }
    const q = await local(`data/toy/${$("qualityScope").value}/quality-summary.json`);
    if (dataMode !== "sample") return;
    $("qualityStats").replaceChildren(
      stat(nf.format(q.records), "veteran-relevant IRS records"),
      stat(`${Math.round((q.records_flagged / q.records) * 100)}%`, "carry a flag"),
      stat(nf.format(q.records_by_origin?.rule_proposed || 0), "name-only candidates"),
      stat(nf.format(q.directory_resources || 0), "directory services"),
      stat(String(q.counties_unknown), "counties with no records"),
    );
    hbar($("qualityChart"), Object.entries(q.flags).map(([f, n]) => ({ label: flagText(f), value: n, note: f })));
    const used = Object.keys(q.flags);
    $("flagDefs").replaceChildren(...used.flatMap((f) => [node("dt", { text: f }), node("dd", { text: flagText(f) })]));
    sourceNote($("qualitySource"), [[`data/toy/${$("qualityScope").value}/quality-summary.json, generated ${String(q.generated_at || "").slice(0, 10)}`, `data/toy/${$("qualityScope").value}/quality-summary.json`]]);
  } catch (err) {
    $("qualityStats").textContent = `Quality summary unavailable (${err.message}).`;
  }
}

// --- Forecast ---------------------------------------------------------------------------

const MODEL_NAMES = { lr: "Logistic regression", rfc: "Random forest", xgboost: "XGBoost" };
async function drawForecast() {
  const draw = async () => {
    try {
      const d = await local(`${MODELS}/${$("modelPick").value}.json`);
      hbar($("importanceChart"), (d.feature_importance?.xgboost || []).slice(0, 12).map((f) => ({ label: f.Feature.replace(/^(Emp|Est|Pay)-(\d+)-/, (_, p, c) => `${{ Emp: "Employees", Est: "Establishments", Pay: "Payroll" }[p]} · ${c} `), value: f.Importance, note: "XGBoost split count" })), { format: (v) => String(v) });
      const rows = (d.cv?.results || []).filter((r) => r.model !== "MajorityBaseline").map((r) => ({ label: MODEL_NAMES[r.model] || r.model, mean: r.roc_auc_mean, sd: r.roc_auc_std }));
      dotWhisker($("cvChart"), rows);
    } catch (err) {
      $("importanceChart").textContent = `Model results unavailable (${err.message}).`;
    }
  };
  $("modelPick").addEventListener("change", draw);
  await draw();
}

// --- Developers -------------------------------------------------------------------------

let toolList = [];
async function initDevelopers() {
  const base = new URL(API || "/", location.origin).href.replace(/\/$/, "");
  $("connectCli").textContent = `claude mcp add --transport http goals ${base}/mcp`;
  $("connectJson").textContent = JSON.stringify({ mcpServers: { "goals": { url: `${base}/mcp` } } }, null, 2);
  for (const [id, p] of [["lnkOpenapi", "/openapi.json"], ["lnkLlms", "/llms.txt"], ["lnkAgent", "/agent.json"], ["lnkHealth", "/health"]]) $(id).href = API + p;
  const pick = $("toolPick");
  pick.replaceChildren(...toolList.map((t) => node("option", { value: t.name, text: t.name })));
  const example = { search_services: { postal_code: "30260", limit: 5 }, get_county_profile: { county_fips: "13063" }, get_coverage: { region: "GA", limit: 10 }, lookup_crosswalk: { scheme: "naics-hs", code: "3361" }, lookup_form: { form_id: "21-526EZ" }, ask: { message: "How do I get my military records?" } };
  const sync = () => {
    const t = toolList.find((x) => x.name === pick.value);
    $("toolDesc").textContent = t?.description || "";
    const props = Object.keys(t?.inputSchema?.properties || {});
    $("toolArgs").value = JSON.stringify(example[pick.value] || Object.fromEntries((t?.inputSchema?.required || []).map((k) => [k, ""])), null, 1);
    $("toolArgs").setAttribute("aria-description", `Arguments: ${props.join(", ")}`);
  };
  pick.addEventListener("change", sync);
  pick.value = "search_services";
  sync();
  $("toolRun").addEventListener("click", async () => {
    $("toolOut").textContent = "Running…";
    try {
      const args = JSON.parse($("toolArgs").value || "{}");
      const res = await fetch(API + "/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: pick.value, arguments: args } }),
      });
      const body = await res.json();
      $("toolOut").textContent = JSON.stringify(body.result?.structuredContent ?? body, null, 2);
    } catch (err) {
      $("toolOut").textContent = `Error: ${err.message}`;
    }
  });
}

// Plan tab: PLAN.md through localsite's loadMarkdown, or as plain text without localsite.
function initPlan() {
  if (typeof window.loadMarkdown === "function") return window.loadMarkdown("PLAN.md", "planDiv", "_parent");
  fetch("PLAN.md").then((r) => r.text()).then((md) => {
    $("planDiv").replaceChildren(node("pre", { style: "white-space:pre-wrap", text: md }));
  });
}

// --- Start ------------------------------------------------------------------------------

async function start() {
  DEFAULTS.title = $("goalsTitle").textContent;
  DEFAULTS.eyebrow = $("goalsEyebrow").textContent;
  DEFAULTS.lede = $("goalsLede").textContent;
  setDataMode(hashParams().data, false);
  markTab(tabName(hashParams().tab)); // before the awaits below, so a #tab= link never flashes the hero
  initMainGrip();
  initFilterCatch();
  syncMainDrop();
  for (const sel of document.querySelectorAll("select[data-source]")) {
    sel.addEventListener("change", () => { setHash({ data: sel.value === "live" ? "live" : "" }); setDataMode(sel.value); });
  }
  // Respond to hash edits: localsite's hashChangeEvent when loaded, else hashchange.
  let lastEvent = hashParams().event || "", lastView = hashParams().view || "";
  const onHash = async () => {
    const h = hashParams();
    if ((h.event || "") !== lastEvent) { lastEvent = h.event || ""; await applyEvent(); lastView = null; }
    if (lastView === null || (h.view || "") !== lastView) { lastView = h.view || ""; applyView(); }
    if ((h.data === "live" ? "live" : "sample") !== dataMode) setDataMode(h.data);
    if (tabName(h.tab) !== $("goalsMain").dataset.tab) showTab(tabName(h.tab), h.tab ? tabName(h.tab) : "");
    else markButtons(h.tab ? tabName(h.tab) : ""); // tab=goals added or removed
    syncMainDrop(true);
  };
  if (hasLocalsiteHash()) document.addEventListener("hashChangeEvent", onHash);
  else window.addEventListener("hashchange", onHash);
  await applyEvent();
  applyView();
  syncMainDrop(false, true); // Again, now the event's top info line is in
  const onResize = () => { fitPageHeight(); alignAside(); syncMainDrop(false, true); };
  if (window.ResizeObserver) {
    // #goalsMain and the localsite header too: a side tab (sidetab=) can shorten
    // the header while the page's fullscreen height grows to match, leaving the
    // body's size, but not the column's place, unchanged.
    const ro = new ResizeObserver(onResize);
    ro.observe(document.body);
    ro.observe($("goalsMain"));
    if (typeof window.onElmReady === "function") window.onElmReady("#main-header", (h) => ro.observe(h));
  } else window.addEventListener("resize", onResize);
  WIDE.addEventListener?.("change", placeSides);
  // The Earth map arriving in #fullscreen, or showing and hiding there, stops or restarts the photos.
  new MutationObserver(syncHero).observe($("fullscreen"), { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden"] });
  // On document rather than #fullscreen, since the voice widget moves the play button into its controls (localsite's initFullscreenVoice()).
  document.addEventListener("click", heroButton, true);
  document.addEventListener("keydown", heroButton, true);
  document.addEventListener("keydown", heroArrowKeys);
  initObjectives();
  // Goals while tab=goals is already set removes tab=, which drops the column to the bottom.
  for (const b of document.querySelectorAll(".goals-tabs button[data-tab]")) b.addEventListener("click", () => {
    closeEarthFilters();
    document.querySelector(".claude-voice-keys-close")?.click(); // The voice widget's keys panel, after #earthFilterCatch (engine/claude-voice.js)
    showTab(b.dataset.tab, b.dataset.tab === "goals" && hashParams().tab === "goals" ? "" : b.dataset.tab);
  });
  $("askForm").addEventListener("submit", ask);
  $("askZip").value = savedZip();
  $("askZip").addEventListener("input", () => saveZip($("askZip").value.trim()));
  $("searchBtn").addEventListener("click", listServices);
  const examples = [
    ["Job training near 30260", "Job training that uses my logistics experience", "30260"],
    ["PTSD counseling in Georgia", "PTSD counseling", ""],
    ["Housing help", "I need help with housing", "30260"],
    ["Get my DD-214", "How do I get a copy of my DD-214?", ""],
  ];
  $("exampleChips").replaceChildren(...examples.map(([label, text, zip]) => {
    const b = node("button", { type: "button", text: label });
    b.addEventListener("click", () => { $("askText").value = text; $("askZip").value = zip || savedZip(); ask(); });
    return b;
  }));
  try {
    toolList = (await api("/tools")).tools;
    const cats = toolList.find((t) => t.name === "search_services")?.inputSchema.properties.category.enum || [];
    $("askCategory").append(...cats.map((c) => node("option", { value: c, text: c.replace(/_/g, " ") })));
  } catch (err) {
    console.warn("[goals] API unavailable at", API || "/", err.message);
  }
  showTab(tabName(hashParams().tab), hashParams().tab ? tabName(hashParams().tab) : "");
}

start();
