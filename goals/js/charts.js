// Small SVG charts for Project Goals: horizontal bars, a dot-and-whisker
// plot and a scatter. Colors come from CSS tokens (css/goals.css),
// text uses text tokens, every mark has a hover/focus tooltip, and each chart
// has a table view so no value depends on hover or color alone.

const NS = "http://www.w3.org/2000/svg";
const tip = () => document.getElementById("goalsTip");
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
function text(parent, x, y, value, attrs = {}) {
  const t = el("text", { x, y, ...attrs }, parent);
  t.textContent = value;
  return t;
}

function showTip(evt, value, label, note) {
  const t = tip();
  if (!t) return;
  t.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  t.append(strong, span);
  if (note) {
    const n = document.createElement("div");
    n.textContent = note;
    n.style.opacity = "0.8";
    t.append(n);
  }
  t.hidden = false;
  const r = evt.target.getBoundingClientRect?.() || { left: evt.clientX, top: evt.clientY, width: 0 };
  const x = evt.clientX ?? r.left + r.width / 2;
  const y = evt.clientY ?? r.top;
  t.style.left = Math.min(window.innerWidth - 270, x + 12) + "px";
  t.style.top = Math.max(8, y - 12 - t.offsetHeight) + "px";
}
function hideTip() { const t = tip(); if (t) t.hidden = true; }

function hover(node, value, label, note) {
  node.setAttribute("tabindex", "0");
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", `${label}: ${value}`);
  node.addEventListener("pointermove", (e) => showTip(e, value, label, note));
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("focus", (e) => {
    const r = e.target.getBoundingClientRect();
    showTip({ target: e.target, clientX: r.left + r.width / 2, clientY: r.top }, value, label, note);
  });
  node.addEventListener("blur", hideTip);
}

function tableView(container, headers, rows) {
  const btn = document.createElement("button");
  btn.className = "goals-table-toggle";
  btn.type = "button";
  btn.textContent = "Show table";
  const table = document.createElement("table");
  table.className = "goals-table";
  table.hidden = true;
  const head = table.createTHead().insertRow();
  for (const h of headers) { const th = document.createElement("th"); th.textContent = h; head.appendChild(th); }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const v of r) { const td = tr.insertCell(); td.textContent = v; if (typeof v === "number") td.className = "n"; }
  }
  btn.addEventListener("click", () => {
    table.hidden = !table.hidden;
    btn.textContent = table.hidden ? "Show table" : "Hide table";
  });
  container.append(btn, table);
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const ellipsize = (s, max) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

// Horizontal bars, one series. rows: [{ label, value, note? }]
export function hbar(container, rows, { format = (v) => fmt.format(v), unit = "" } = {}) {
  container.replaceChildren();
  if (!rows.length) { container.textContent = "No data."; return; }
  const width = Math.max(320, container.clientWidth || 560);
  const maxChars = width < 480 ? 22 : 34;
  const labelW = Math.min(width * 0.45, 8 + 6.4 * Math.max(...rows.map((r) => Math.min(maxChars, r.label.length))));
  const valueW = 56, rowH = 26, barH = 16, top = 4;
  const plotW = width - labelW - valueW;
  const max = niceMax(Math.max(...rows.map((r) => r.value)));
  const height = top + rows.length * rowH + 22;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "group" }, container);
  for (let i = 0; i <= 4; i++) {
    const x = labelW + (plotW * i) / 4;
    el("line", { x1: x, x2: x, y1: top, y2: height - 18, class: i === 0 ? "base" : "grid" }, svg);
    text(svg, x, height - 4, compact.format((max * i) / 4), { "text-anchor": "middle" });
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    const w = Math.max(0, (r.value / max) * plotW);
    text(svg, labelW - 8, y + barH / 2 + 4, ellipsize(r.label, maxChars), { "text-anchor": "end" });
    // 4px rounded data-end, square at the baseline.
    const rad = Math.min(4, w);
    const d = `M${labelW},${y}h${w - rad}a${rad},${rad} 0 0 1 ${rad},${rad}v${barH - 2 * rad}a${rad},${rad} 0 0 1 -${rad},${rad}h-${w - rad}z`;
    const hit = el("rect", { x: labelW, y: top + i * rowH, width: plotW, height: rowH, fill: "transparent" }, svg);
    const bar = el("path", { d, class: "mark" }, svg);
    text(svg, labelW + w + 6, y + barH / 2 + 4, format(r.value) + unit, { class: "val" });
    hover(hit, format(r.value) + unit, r.label, r.note);
  });
  tableView(container, ["Item", "Value"], rows.map((r) => [r.label, r.value]));
}

// Mean ± SD per row on a fixed 0..1 scale with a reference line.
// rows: [{ label, mean, sd }]
export function dotWhisker(container, rows, { min = 0.3, max = 1, ref = 0.5, refLabel = "chance" } = {}) {
  container.replaceChildren();
  if (!rows.length) { container.textContent = "No data."; return; }
  const width = Math.max(320, container.clientWidth || 560);
  const labelW = 150, rowH = 34, top = 18;
  const plotW = width - labelW - 24;
  const x = (v) => labelW + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * plotW;
  const height = top + rows.length * rowH + 24;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "group" }, container);
  for (let v = min; v <= max + 1e-9; v += 0.1) {
    el("line", { x1: x(v), x2: x(v), y1: top - 6, y2: height - 20, class: "grid" }, svg);
    text(svg, x(v), height - 4, v.toFixed(1), { "text-anchor": "middle" });
  }
  el("line", { x1: x(ref), x2: x(ref), y1: top - 10, y2: height - 20, class: "ref" }, svg);
  text(svg, x(ref) + 4, top - 6, refLabel);
  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    text(svg, labelW - 10, cy + 4, r.label, { "text-anchor": "end" });
    el("line", { x1: x(r.mean - r.sd), x2: x(r.mean + r.sd), y1: cy, y2: cy, class: "whisker" }, svg);
    const hit = el("rect", { x: labelW, y: cy - rowH / 2, width: plotW, height: rowH, fill: "transparent" }, svg);
    el("circle", { cx: x(r.mean), cy, r: 5, class: "dot" }, svg);
    text(svg, x(r.mean + r.sd) + 8, cy + 4, r.mean.toFixed(2), { class: "val" });
    hover(hit, `${r.mean.toFixed(2)} ± ${r.sd.toFixed(2)}`, r.label);
  });
  tableView(container, ["Model", "Mean", "SD"], rows.map((r) => [r.label, +r.mean.toFixed(3), +r.sd.toFixed(3)]));
}

// Scatter on square-root axes (both rates are right-skewed). One color; the
// highlighted group stays in the series color and the rest recede to gray.
// points: [{ x, y, label, group }]
export function scatter(container, points, { xLabel, yLabel, highlight } = {}) {
  container.replaceChildren();
  if (!points.length) { container.textContent = "No data."; return; }
  const width = Math.max(320, container.clientWidth || 560);
  const height = Math.round(Math.min(420, width * 0.75));
  const m = { l: 44, r: 12, t: 10, b: 40 };
  const sx = niceMax(quantile(points.map((p) => p.x), 0.99));
  const sy = niceMax(quantile(points.map((p) => p.y), 0.99));
  const X = (v) => m.l + Math.sqrt(Math.min(v, sx) / sx) * (width - m.l - m.r);
  const Y = (v) => height - m.b - Math.sqrt(Math.min(v, sy) / sy) * (height - m.t - m.b);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "group" }, container);
  for (const f of [0, 0.25, 0.5, 1]) {
    el("line", { x1: X(sx * f), x2: X(sx * f), y1: m.t, y2: height - m.b, class: f ? "grid" : "base" }, svg);
    text(svg, X(sx * f), height - m.b + 16, fmt.format(sx * f), { "text-anchor": "middle" });
    el("line", { x1: m.l, x2: width - m.r, y1: Y(sy * f), y2: Y(sy * f), class: f ? "grid" : "base" }, svg);
    text(svg, m.l - 6, Y(sy * f) + 4, fmt.format(sy * f), { "text-anchor": "end" });
  }
  text(svg, (width + m.l) / 2, height - 4, xLabel, { "text-anchor": "middle" });
  text(svg, 4, m.t + 2, yLabel, { "dominant-baseline": "hanging" });
  const ordered = [...points].sort((a, b) => (a.group === highlight) - (b.group === highlight));
  for (const p of ordered) {
    const on = !highlight || p.group === highlight;
    const g = el("g", {}, svg);
    el("circle", { cx: X(p.x), cy: Y(p.y), r: 9, fill: "transparent" }, g);
    el("circle", { cx: X(p.x), cy: Y(p.y), r: 4, class: on ? "dot" : "dot dim" }, g);
    hover(g, `${fmt.format(p.x)} / ${fmt.format(p.y)}`, p.label, `${xLabel} / ${yLabel}`);
  }
  tableView(container, ["County", xLabel, yLabel], points.map((p) => [p.label, p.x, p.y]));
}

export function quantile(values, q) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function spearman(xs, ys) {
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
