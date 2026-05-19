/* event-hub.js — loads event YAML and renders #topinfo panel + section banners */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var EVENTS_BASE     = './events';
  var EVENTS_FALLBACK = '../events';
  var DEFAULT_EVENT   = 'iran-energy';

  var EDITABLE_FIELDS = [
    'reactorPower', 'wasteHeatFactor', 'medEfficiency', 'numEffects',
    'topBrineTemp', 'availability', 'waterPrice', 'medCapitalCost',
    'retrofitMultiplier', 'plantPurchasePrice', 'wasteTunnelLength',
    'fuelTunnelLength', 'boringCostPerKm'
  ];

  // ── Null-safe deep accessor ────────────────────────────────────────────────
  function safeGet(obj) {
    var keys = Array.prototype.slice.call(arguments, 1);
    return keys.reduce(function (acc, k) {
      return acc != null && typeof acc === 'object' ? acc[k] : undefined;
    }, obj);
  }

  // ── Formatting helpers ─────────────────────────────────────────────────────
  function fmtM(val) {
    if (val == null || !isFinite(val)) return '—';
    var b = val / 1e9;
    if (Math.abs(b) >= 1) return '$' + b.toFixed(b < 10 ? 2 : 1).replace(/\.?0+$/, '') + 'B';
    return '$' + (val / 1e6).toFixed(0) + 'M';
  }

  function fmtK(val) {
    if (val == null || !isFinite(val)) return '—';
    if (val >= 1e6) return (val / 1e6).toFixed(2) + 'M';
    if (val >= 1e3) return Math.round(val / 1000) + 'K';
    return String(val);
  }

  function fmtPct(val) {
    return (val != null && isFinite(val)) ? val + '%' : '—';
  }

  function buildProjectAdminHref(eventId) {
    var slug = (eventId || getActiveEventId() || DEFAULT_EVENT).replace(/[^a-zA-Z0-9_-]/g, '');
    return '/project/admin/#event=' + encodeURIComponent(slug);
  }

  var _scenarioDataCollapsed = false;
  var _scenarioDataPointer = null;

  function getScenarioDataScrollTarget() {
    return document.getElementById('topinfo')
      || document.getElementById('scenarioDataPanel')
      || document.getElementById('projectOverview')
      || document.getElementById('studio');
  }

  function isScenarioDataSelectionClick(link, event) {
    var pointer = _scenarioDataPointer;
    _scenarioDataPointer = null;

    var selection = null;
    var selectionText = '';
    try {
      selection = window.getSelection ? window.getSelection() : null;
      selectionText = String(selection ? selection.toString() : '').trim();
    } catch (_) {
      selection = null;
      selectionText = '';
    }

    if (selectionText) {
      try {
        if (!selection || !selection.rangeCount) return true;
        var range = selection.getRangeAt(0);
        return range.intersectsNode(link);
      } catch (_) {
        return true;
      }
    }
    if (!pointer || !event) return false;

    var dx = Math.abs((event.clientX || 0) - pointer.x);
    var dy = Math.abs((event.clientY || 0) - pointer.y);
    return pointer.link === link && (dx > 4 || dy > 4);
  }

  function revealScenarioData() {
    setScenarioDataCollapsed(false);
    var target = getScenarioDataScrollTarget();
    if (target && typeof target.scrollIntoView === 'function') {
      requestAnimationFrame(function () {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest
      ? event.target.closest('#hud-scenario-data-link')
      : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    if (isScenarioDataSelectionClick(link, event)) return;
    revealScenarioData();
  }, true);

  function bindScenarioDataLink(link) {
    if (!link) return;
    link.hidden = !_scenarioDataCollapsed;
    link.setAttribute('href', '#topinfo');
    link.style.userSelect = 'text';
    link.style.webkitUserSelect = 'text';
    if (link.dataset.scenarioDataBound) return;
    link.addEventListener('pointerdown', function (event) {
      _scenarioDataPointer = {
        link: link,
        x: event.clientX || 0,
        y: event.clientY || 0
      };
    });
    link.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (isScenarioDataSelectionClick(link, event)) return;
      revealScenarioData();
    });
    link.dataset.scenarioDataBound = 'true';
  }

  function setScenarioDataCollapsed(collapsed) {
    _scenarioDataCollapsed = Boolean(collapsed);
    var topinfo = document.getElementById('topinfo');
    var overview = document.getElementById('projectOverview');
    var link = document.getElementById('hud-scenario-data-link');
    if (topinfo) topinfo.hidden = _scenarioDataCollapsed;
    if (overview) overview.hidden = _scenarioDataCollapsed;
    if (link) {
      bindScenarioDataLink(link);
      return;
    }
    if (typeof waitForElm === 'function') {
      waitForElm('#hud-scenario-data-link').then(function (scenarioLink) {
        bindScenarioDataLink(scenarioLink);
      });
    }
  }

  // ── Active event id ────────────────────────────────────────────────────────
  function getActiveEventId() {
    var hash = typeof getHash === 'function' ? getHash() : {};
    return (hash.event || '').replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function userEditsKey(eventId) {
    return 'eventHubUserEdits_' + (eventId || DEFAULT_EVENT);
  }

  // ── YAML fetch with fallback ───────────────────────────────────────────────
  function loadEventYaml(eventId) {
    var slug = (eventId || DEFAULT_EVENT).replace(/[^a-zA-Z0-9_-]/g, '');
    var primary  = EVENTS_BASE + '/' + slug + '.yaml';
    var fallback = EVENTS_FALLBACK + '/' + slug + '.yaml';
    function tryFetch(url) {
      return fetch(url, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
          return r.text();
        });
    }
    return tryFetch(primary)
      .catch(function () { return tryFetch(fallback); })
      .then(function (text) {
        if (!window.YAML || typeof window.YAML.parse !== 'function') {
          throw new Error('window.YAML not available');
        }
        return window.YAML.parse(text);
      });
  }

  // ── Data path helpers (YAML structure) ────────────────────────────────────
  // iran-energy.yaml stores scenario data under modeled_assumptions:
  //   data.modeled_assumptions.energy_scenarios
  //   data.modeled_assumptions.abundance_engine_sections
  //   data.risk_matrix.most_at_risk (for individual risk dimensions)
  function getAe(data)  { return safeGet(data, 'modeled_assumptions', 'abundance_engine_sections') || {}; }
  function getScen(data){ return safeGet(data, 'modeled_assumptions', 'energy_scenarios') || {}; }
  function getRisk(data){ return safeGet(data, 'risk_matrix', 'most_at_risk') || {}; }

  // ── localStorage user edits ────────────────────────────────────────────────
  function getUserEdits(eventId) {
    try { return JSON.parse(localStorage.getItem(userEditsKey(eventId)) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function saveUserEdits(edits, eventId) {
    try {
      var key = userEditsKey(eventId);
      if (Object.keys(edits).length) {
        localStorage.setItem(key, JSON.stringify(edits));
      } else {
        localStorage.removeItem(key);
      }
    } catch (_) {}
  }

  // ── Calculator field seeding ───────────────────────────────────────────────
  function seedCalculatorFields(data, eventId) {
    var ae = getAe(data);
    var defaults = safeGet(ae, 'engineering_section', 'parameters', 'calculator_defaults') || {};
    var userEdits = getUserEdits(eventId);
    var merged = Object.assign({}, defaults, userEdits);
    EDITABLE_FIELDS.forEach(function (id) {
      if (!Object.prototype.hasOwnProperty.call(merged, id)) return;
      var el = document.getElementById(id);
      if (el) el.value = merged[id];
    });
  }

  function buildDiffFromFields(yamlDefaults) {
    var diff = {};
    EDITABLE_FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var val = parseFloat(el.value);
      if (!isFinite(val)) return;
      if (val !== yamlDefaults[id]) diff[id] = val;
    });
    return diff;
  }

  // ── Hub HTML builder ───────────────────────────────────────────────────────
  function buildHubMarkup(data) {
    var missionName = data.mission_name || data.label || 'Project Event';
    var phaseText   = data.phase_text || '';
    var confidence  = safeGet(data, 'modeled_assumptions', 'confidence_percent');
    var sourceUrl   = data.source_url || '#';
    var phaseLabels = data.phase_labels || [];
    var startYear   = data.start_date ? String(new Date(data.start_date).getUTCFullYear()) : '';
    var endYear     = data.end_date   ? String(new Date(data.end_date).getUTCFullYear())   : '';

    var totalMin = safeGet(data, 'cost_ranges', 'total_scenario_range_usd', 0);
    var totalMax = safeGet(data, 'cost_ranges', 'total_scenario_range_usd', 1);
    var waterMin = safeGet(data, 'source_confirmed', 'power_context', 'bushehr_desal_m3_day') || 70000;
    var waterMax = safeGet(getAe(data), 'water_section', 'parameters', 'combined_max_m3_day') || 1060000;
    var displaced = safeGet(data, 'source_confirmed', 'water_context', 'displaced_persons_water') || 0;
    var sc = getScen(data);
    var popServed = safeGet(sc, 'regenerative_100unit_corridor_case', 'water_impact', 'population_served_at_200L_per_day') || 0;

    var scenarios = [
      { label: 'No-conversion',    pct: safeGet(sc, 'baseline_no_conversion_case', 'confidence_percent'),        cls: 'hub-pill-high' },
      { label: 'IAEA 10-unit',     pct: safeGet(sc, 'transition_iaea_10unit_case', 'confidence_percent'),        cls: 'hub-pill-med'  },
      { label: '100-unit corridor', pct: safeGet(sc, 'regenerative_100unit_corridor_case', 'confidence_percent'), cls: 'hub-pill-low'  }
    ];

    var pillsHtml = scenarios.map(function (s) {
      return '<span class="hub-pill ' + s.cls + '">' + s.label + ' ' + fmtPct(s.pct) + '</span>';
    }).join('');

    var phaseBarHtml = '';
    if (phaseLabels.length) {
      phaseBarHtml = '<div class="hub-phase-bar">' +
        phaseLabels.map(function (p) {
          return '<div class="hub-phase-pill">' + p + '</div>';
        }).join('') +
        '</div>';
    }

    var html = '';
    html += '<div id="topinfo" class="event-hub-panel">';

    // Identity bar
    html += '<div class="hub-identity-bar">';
    html += '<span class="hub-mission-name"><span class="material-icons" style="color:var(--hero-1);font-size:20px">hub</span>' + missionName + '</span>';
    if (phaseText) html += '<span class="hub-phase-text">' + phaseText + '</span>';
    if (startYear || endYear) html += '<span class="hub-phase-text" style="opacity:.7">' + startYear + '–' + endYear + '</span>';
    if (confidence != null) html += '<span class="hub-confidence-badge">' + fmtPct(confidence) + ' model confidence</span>';
    html += '<a class="hub-source-link" href="' + sourceUrl + '" target="_blank" rel="noopener"><span class="material-icons" style="font-size:14px;vertical-align:middle">open_in_new</span> Source</a>';
    html += '</div>';

    // Summary cards
    html += '<div class="panel-summary-grid hub-totals">';
    html += '<div class="summary-card"><span class="label">Total cost range</span><span class="value">' + fmtM(totalMin) + ' – ' + fmtM(totalMax) + '</span><span class="detail">Concept-to-full 100-unit corridor</span></div>';
    html += '<div class="summary-card"><span class="label">Water output range</span><span class="value">' + fmtK(waterMin) + ' – ' + fmtK(waterMax) + ' m³/day</span><span class="detail">Bushehr baseline → 100-unit DeepFission</span></div>';
    html += '<div class="summary-card"><span class="label">Water-displaced persons</span><span class="value">' + (displaced ? (displaced / 1e6).toFixed(0) + 'M' : '—') + '</span><span class="detail">As of 2025 (WRI classification)</span></div>';
    html += '<div class="summary-card"><span class="label">Population served (full)</span><span class="value">' + (popServed ? (popServed / 1e6).toFixed(2) + 'M' : '—') + '</span><span class="detail">At 200 L/day, 100-unit corridor</span></div>';
    html += '</div>';

    html += phaseBarHtml;

    // Scenario pills
    html += '<div class="hub-scenario-pills"><span class="hub-scenario-label">Scenario confidence:</span>' + pillsHtml + '</div>';

    // Chart containers
    html += '<div class="hub-charts-row">';
    html += '<div class="hub-chart-wrap"><div class="hub-chart-label">Generation mix by scenario</div><div id="hubScenarioChart" style="height:220px;"></div></div>';
    html += '<div class="hub-chart-wrap"><div class="hub-chart-label">Cost range by phase (USD)</div><div id="hubCostChart" style="height:220px;"></div></div>';
    html += '<div class="hub-chart-wrap"><div class="hub-chart-label">Risk dimension confidence</div><div id="hubRiskChart" style="height:220px;"></div></div>';
    html += '</div>';

    // Reset row
    html += '<div class="hub-reset-row" id="hubResetRow" hidden><button type="button" class="hub-reset-btn" id="hubResetBtn"><span class="material-icons">restart_alt</span>Reset calculator to YAML defaults</button></div>';

    html += '</div>';
    return html;
  }

  // ── ECharts instances ──────────────────────────────────────────────────────
  var _hubCharts = [];

  function renderHubCharts(data) {
    if (typeof echarts === 'undefined') return;

    var sc = getScen(data);
    var base = safeGet(sc, 'baseline_no_conversion_case', 'generation_mix_percent') || {};
    var iaea = safeGet(sc, 'transition_iaea_10unit_case', 'generation_mix_percent') || {};
    var full = safeGet(sc, 'regenerative_100unit_corridor_case', 'generation_mix_percent') || {};

    var sources   = ['Nuclear', 'Gas', 'Oil/Diesel', 'Solar', 'Wind', 'Renewables'];
    var baseData  = [base.nuclear || 0, base.natural_gas || 0, base.oil_diesel || 0, base.solar || 0, base.wind || 0, base.renewables || 0];
    var iaeaData  = [(iaea.nuclear_deepfission || 0) + (iaea.nuclear_bushehr || 0), iaea.natural_gas || 0, iaea.oil_diesel || 0, iaea.solar || 0, iaea.wind || 0, iaea.renewables || 0];
    var fullData  = [(full.nuclear_deepfission || 0) + (full.nuclear_bushehr || 0), full.natural_gas || 0, full.oil_diesel || 0, full.solar || 0, full.wind || 0, (full.other_renewables || 0)];

    // Chart 1: scenario generation mix
    var dom1 = document.getElementById('hubScenarioChart');
    if (dom1) {
      var c1 = echarts.init(dom1);
      _hubCharts.push(c1);
      c1.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { bottom: 4, textStyle: { fontSize: 10 }, data: ['No-conv (38%)', 'IAEA 10-unit (19%)', '100-unit (11%)'] },
        grid: { left: 60, right: 12, top: 12, bottom: 54 },
        xAxis: { type: 'category', data: sources, axisLabel: { fontSize: 10 } },
        yAxis: { type: 'value', name: '%', max: 80, axisLabel: { fontSize: 10 } },
        color: ['#ef8354', '#0f9d58', '#0f7173'],
        series: [
          { name: 'No-conv (38%)',      type: 'bar', data: baseData },
          { name: 'IAEA 10-unit (19%)', type: 'bar', data: iaeaData },
          { name: '100-unit (11%)',     type: 'bar', data: fullData }
        ]
      });
    }

    // Chart 2: cost ranges (floating bar)
    var cr = safeGet(data, 'cost_ranges') || {};
    var phases = ['Verification', 'Conversion', 'DeepFission 10u', 'MED Coastal', '100u+Conveyance'];
    var phaseKeys = [
      'phase_1_verification_and_diplomacy_usd',
      'phase_2_conversion_and_fabrication_usd',
      'phase_3_deepfission_10unit_array_usd',
      'phase_4_med_desal_coastal_infrastructure_usd',
      'phase_5_100unit_corridor_and_conveyance_usd'
    ];
    var costMins   = phaseKeys.map(function (k) { return ((cr[k] || [0])[0] || 0) / 1e9; });
    var costRanges = phaseKeys.map(function (k, i) { return (((cr[k] || [0, 0])[1] || 0) / 1e9) - costMins[i]; });

    var dom2 = document.getElementById('hubCostChart');
    if (dom2) {
      var c2 = echarts.init(dom2);
      _hubCharts.push(c2);
      c2.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: function (params) {
            var idx = params[0].dataIndex;
            var lo = costMins[idx], hi = lo + costRanges[idx];
            return phases[idx] + '<br/>$' + lo.toFixed(2) + 'B – $' + hi.toFixed(2) + 'B';
          }
        },
        grid: { left: 110, right: 120, top: 12, bottom: 32 },
        xAxis: { type: 'value', axisLabel: { fontSize: 9, formatter: '${value}B' } },
        yAxis: { type: 'category', data: phases, axisLabel: { fontSize: 10 } },
        color: ['transparent', '#0f7173'],
        series: [
          { type: 'bar', stack: 'rng', data: costMins,   itemStyle: { color: 'transparent' }, tooltip: { show: false } },
          { type: 'bar', stack: 'rng', data: costRanges, itemStyle: { color: '#0f7173', opacity: 0.75 }, barWidth: '52%',
            label: {
              show: true, position: 'right', fontSize: 9, color: 'var(--ink-1)',
              formatter: function (params) {
                var idx = params.dataIndex;
                var lo = costMins[idx], hi = lo + costRanges[idx];
                return '$' + lo.toFixed(1) + 'B – $' + hi.toFixed(1) + 'B';
              }
            }
          }
        ]
      });
    }

    // Chart 3: risk radar
    var rm = getRisk(data);
    var rDims = [
      { key: 'populations',            label: 'Populations' },
      { key: 'proliferation_stability',label: 'Proliferation' },
      { key: 'diplomatic_framework',   label: 'Diplomacy' },
      { key: 'technology_execution',   label: 'Technology' },
      { key: 'coastal_ecology',        label: 'Ecology' },
      { key: 'sanctions_and_finance',  label: 'Sanctions' }
    ];
    var riskConf = rDims.map(function (d) { return safeGet(rm, d.key, 'confidence_percent') || 0; });

    var dom3 = document.getElementById('hubRiskChart');
    if (dom3) {
      var c3 = echarts.init(dom3);
      _hubCharts.push(c3);
      c3.setOption({
        tooltip: {},
        radar: {
          indicator: rDims.map(function (d) { return { name: d.label, max: 60 }; }),
          radius: '60%',
          name: { fontSize: 10 }
        },
        series: [{
          type: 'radar',
          data: [{
            value: riskConf,
            name: 'Risk confidence %',
            areaStyle: { color: 'rgba(15,113,115,0.18)' },
            lineStyle: { color: '#0f7173' },
            itemStyle: { color: '#0f7173' }
          }]
        }]
      });
    }
  }

  function resizeHubCharts() {
    _hubCharts.forEach(function (c) { try { c.resize(); } catch (_) {} });
    _overviewCharts.forEach(function (c) { try { c.resize(); } catch (_) {} });
  }

  window.resizeHubCharts = resizeHubCharts;

  // ── Project Overview panel ─────────────────────────────────────────────────
  var _overviewCharts = [];

  function renderProjectOverview(data, eventId) {
    var ov = document.getElementById('projectOverview');
    if (!ov) return;

    _overviewCharts.forEach(function (c) { try { c.dispose(); } catch (_) {} });
    _overviewCharts = [];

    var ae = getAe(data);
    var eo  = safeGet(ae, 'engineering_section', 'parameters', 'calculator_expected_output') || {};
    var defs = safeGet(ae, 'engineering_section', 'parameters', 'calculator_defaults') || {};
    var sc  = getScen(data);

    // Summary stat cards
    var cards = [];
    if (eo.daily_water_m3_day != null)
      cards.push('<div class="summary-card"><span class="label">Calculated daily water</span><span class="value">' + fmtK(eo.daily_water_m3_day) + ' m³/day</span><span class="detail">IAEA 10-unit array, YAML defaults</span></div>');
    if (eo.annual_revenue_usd != null)
      cards.push('<div class="summary-card"><span class="label">Annual water revenue</span><span class="value">' + fmtM(eo.annual_revenue_usd) + '</span><span class="detail">At $' + (defs.waterPrice || '—') + '/m³ water price</span></div>');
    if (eo.total_project_cost_usd != null)
      cards.push('<div class="summary-card"><span class="label">Total project CAPEX</span><span class="value">' + fmtM(eo.total_project_cost_usd) + '</span><span class="detail">MED desal + boring + tunneling</span></div>');
    if (eo.payback_years != null)
      cards.push('<div class="summary-card"><span class="label">Payback period</span><span class="value">' + eo.payback_years + ' yrs</span><span class="detail">At seeded pricing assumptions</span></div>');

    // Water comparison data across scenarios
    var waterScens = [], waterVals = [];
    var baseDesal = safeGet(sc, 'baseline_no_conversion_case', 'desalination_context', 'bushehr_desal_m3_day');
    if (baseDesal != null) { waterScens.push('No-conversion'); waterVals.push(baseDesal); }
    var iaeaDesal = safeGet(sc, 'transition_iaea_10unit_case', 'desalination_output', 'combined_with_bushehr_m3_day');
    if (iaeaDesal != null) { waterScens.push('IAEA 10-unit'); waterVals.push(iaeaDesal); }
    var fullDesal = safeGet(sc, 'regenerative_100unit_corridor_case', 'water_impact', 'combined_desal_m3_day_with_bushehr');
    if (fullDesal != null) { waterScens.push('100-unit corridor'); waterVals.push(fullDesal); }

    // Generation mix for the IAEA 10-unit scenario (primary calculator scenario)
    var mixScen = safeGet(sc, 'transition_iaea_10unit_case', 'generation_mix_percent')
               || safeGet(sc, 'baseline_no_conversion_case', 'generation_mix_percent') || {};
    var mixLabels = { nuclear_deepfission: 'DeepFission', nuclear_bushehr: 'Bushehr', nuclear: 'Nuclear',
                      natural_gas: 'Gas', oil_diesel: 'Oil/Diesel', solar: 'Solar',
                      wind: 'Wind', renewables: 'Renewables', other_renewables: 'Other Ren.' };
    var mixData = [];
    Object.keys(mixScen).forEach(function (k) {
      if (mixScen[k] && mixLabels[k]) mixData.push({ value: mixScen[k], name: mixLabels[k] });
    });

    var hasCards  = cards.length > 0;
    var hasMix    = mixData.length > 0;
    var hasWater  = waterVals.length > 0;
    var hasCharts = typeof echarts !== 'undefined' && (hasMix || hasWater);

    if (!hasCards && !hasCharts) {
      var eventSlug = eventId || data.id || data.object_name || 'this event';
      var adminHref = buildProjectAdminHref(eventSlug);
      ov.innerHTML = '<div id="scenarioDataPanel" style="scroll-margin-top:96px;margin-bottom:20px;background:var(--panel);border-radius:20px;border:1px solid var(--line);box-shadow:var(--soft-shadow);padding:20px 24px;display:flex;align-items:flex-start;gap:12px;">'
        + '<span class="material-icons" style="color:var(--accent-2);font-size:22px;margin-top:1px">info</span>'
        + '<div style="flex:1 1 auto;"><div style="font-weight:600;color:var(--ink-1);margin-bottom:4px;">No scenario data for <em>' + eventSlug + '</em></div>'
        + '<div style="font-size:0.85rem;color:var(--ink-2);">Add <code>modeled_assumptions.energy_scenarios</code> and <code>modeled_assumptions.abundance_engine_sections</code> to <strong>' + eventSlug + '.yaml</strong> to enable scenario charts and calculated outputs.</div>'
        + '<div style="margin-top:14px;"><a href="' + adminHref + '" style="font-size:0.85rem;font-weight:700;color:var(--accent-1);text-decoration:none;">Admin</a></div>'
        + '</div></div>';
      setScenarioDataCollapsed(true);
      return;
    }
    setScenarioDataCollapsed(false);

    var html = '<div id="scenarioDataPanel" style="scroll-margin-top:96px;margin-bottom:20px;background:var(--panel);border-radius:20px;border:1px solid var(--line);box-shadow:var(--soft-shadow);overflow:hidden;">';

    html += '<div style="padding:14px 24px 6px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;">'
          + '<span class="material-icons" style="color:var(--hero-1);font-size:20px">insights</span>'
          + '<span style="font-size:1rem;font-weight:700;color:var(--hero-1);">Calculated Scenario Outputs</span>'
          + '<span style="font-size:0.82rem;color:var(--ink-2);font-style:italic;margin-left:4px;">' + (data.mission_name || data.label || '') + '</span>'
          + '</div>';

    if (hasCards)
      html += '<div class="panel-summary-grid hub-overview-gutter" style="padding-top:12px;padding-bottom:4px;">' + cards.join('') + '</div>';

    if (hasCharts) {
      html += '<div class="hub-charts-row">';
      if (hasMix)
        html += '<div class="hub-chart-wrap"><div class="hub-chart-label">Generation mix — IAEA 10-unit scenario</div><div id="overviewMixChart" style="height:220px;"></div></div>';
      if (hasWater)
        html += '<div class="hub-chart-wrap"><div class="hub-chart-label">Desal water output by scenario (m³/day)</div><div id="overviewWaterChart" style="height:220px;"></div></div>';
      html += '</div>';
    }
    html += '<div id="hub-banners-anchor"></div>';

    html += '</div>';
    ov.innerHTML = html;

    if (typeof echarts === 'undefined') return;

    if (hasMix) {
      var domMix = document.getElementById('overviewMixChart');
      if (domMix) {
        var cMix = echarts.init(domMix);
        _overviewCharts.push(cMix);
        cMix.setOption({
          tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
          legend: { bottom: 2, textStyle: { fontSize: 10 }, orient: 'horizontal' },
          series: [{
            type: 'pie',
            radius: ['36%', '62%'],
            center: ['50%', '44%'],
            data: mixData,
            label: { show: false },
            emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.18)' } },
            color: ['#0f7173', '#0d5c63', '#f2c14e', '#ef8354', '#0f9d58', '#b7791f', '#64b5f6', '#a5d6a7']
          }]
        });
      }
    }

    if (hasWater) {
      var domWater = document.getElementById('overviewWaterChart');
      if (domWater) {
        var cWater = echarts.init(domWater);
        _overviewCharts.push(cWater);
        cWater.setOption({
          tooltip: {
            trigger: 'axis',
            formatter: function (p) { return p[0].name + '<br/>' + Math.round(p[0].value / 1000) + 'K m³/day'; }
          },
          grid: { left: 108, right: 24, top: 14, bottom: 30 },
          xAxis: {
            type: 'value',
            name: 'm³/day',
            axisLabel: { fontSize: 9, formatter: function (v) { return v >= 1000 ? Math.round(v / 1000) + 'K' : v; } }
          },
          yAxis: { type: 'category', data: waterScens, axisLabel: { fontSize: 10 } },
          color: ['#0f7173'],
          series: [{
            type: 'bar',
            data: waterVals,
            barWidth: '46%',
            itemStyle: { borderRadius: [0, 6, 6, 0] },
            label: {
              show: true, position: 'insideRight', fontSize: 10, color: '#fff',
              formatter: function (p) { return Math.round(p.value / 1000) + 'K'; }
            }
          }]
        });
      }
    }
  }

  // ── Section banners ────────────────────────────────────────────────────────
  function stat(label, value) {
    return '<span class="hub-stat"><span class="hub-stat-label">' + label + ':</span> <span class="hub-stat-value">' + value + '</span></span>';
  }

  function chipPct(pct) {
    return '<span class="hub-confidence-chip">' + fmtPct(pct) + ' confidence</span>';
  }

  function renderAllSectionBanners(data, eventId) {
    var existing = document.getElementById('hub-banners');
    if (existing) existing.remove();

    var anchor = document.getElementById('hub-banners-anchor');
    if (!anchor) {
      if (typeof waitForElm === 'function') {
        waitForElm('#hub-banners-anchor').then(function () {
          if ((eventId || '') !== (_activeEventId || '')) return;
          renderAllSectionBanners(data, eventId);
        });
      }
      return;
    }

    var ae = getAe(data);
    var parts = [];

    var studio = ae.studio_section;
    if (studio) {
      var sp = studio.scenario_parameters || {};
      parts.push([
        '<div class="hub-banner-row"><strong>Scenario Parameters</strong>' + chipPct(studio.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Sponsor value/yr', fmtM((sp.sponsor_annual_value_range_usd || [])[0]) + ' – ' + fmtM((sp.sponsor_annual_value_range_usd || [0, 0])[1])),
        stat('Households', (((sp.households_supported_range || [])[0] || 0) / 1e3 | 0) + 'K – ' + ((((sp.households_supported_range || [0, 0])[1]) || 0) / 1e3 | 0) + 'K'),
        stat('Energy portfolio', ((((sp.energy_portfolio_mwh_year_range || [])[0] || 0) / 1e6).toFixed(1)) + 'M – ' + (((sp.energy_portfolio_mwh_year_range || [0, 0])[1] || 0) / 1e6).toFixed(0) + 'M MWh/yr'),
        stat('Water revenue/yr', fmtM((sp.annual_water_revenue_range_usd || [])[0]) + ' – ' + fmtM((sp.annual_water_revenue_range_usd || [0, 0])[1])),
        '</div>'
      ].join(''));
    }

    var ben = ae.benefits_section;
    if (ben) {
      var bp = ben.parameters || {};
      parts.push([
        '<div class="hub-banner-row"><strong>Corridor Benefits</strong>' + chipPct(ben.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Pure water coverage', (bp.pure_water_coverage_percent_range || [5, 55]).join('–') + '%'),
        stat('Daily water output', fmtK((bp.daily_pure_water_output_m3_day_range || [])[0]) + ' – ' + fmtK((bp.daily_pure_water_output_m3_day_range || [0, 0])[1]) + ' m³/day'),
        stat('Carbon value', '$' + (bp.carbon_value_per_tonne_usd_range || [15, 120]).join('–') + '/tonne CO₂'),
        stat('Process water savings', '$' + (bp.process_water_savings_per_m3_usd_range || [0.4, 3.2]).join('–') + '/m³'),
        '</div>'
      ].join(''));
    }

    var eng = ae.engineering_section;
    if (eng) {
      var ep = eng.parameters || {};
      var dfu = ep.deep_fission_reference_unit || {};
      var eo = ep.calculator_expected_output || {};
      parts.push([
        '<div class="hub-banner-row"><strong>DEEP Nuclear for Water Replenishment</strong>' + chipPct(eng.confidence_percent) + '<span class="hub-seeded-note"><span class="material-icons">check_circle</span>Calculator seeded from ' + (data.id || 'event') + '.yaml</span></div>',
        '<div class="hub-banner-row">',
        stat('Reactor power', (ep.reactor_power_mwth_range || [45, 4550]).join('–') + ' MWth'),
        stat('LCOE', '$' + (dfu.lcoe_usd_per_mwh_range || [50, 70]).join('–') + '/MWh'),
        stat('Water price range', '$' + (ep.water_price_usd_per_m3_range || [0.5, 3.5]).join('–') + '/m³'),
        stat('Unit spec', (dfu.mwe_per_bore || 15) + ' MWe · ' + (dfu.bore_depth_miles || 1) + ' mi · ' + (dfu.bore_diameter_inches || 30) + '″Ø'),
        '</div>',
        '<div class="hub-banner-row">',
        stat('Expected daily water', fmtK(eo.daily_water_m3_day) + ' m³/day'),
        stat('Annual revenue', fmtM(eo.annual_revenue_usd)),
        stat('Project cost', fmtM(eo.total_project_cost_usd)),
        stat('Payback', (eo.payback_years || '—') + ' yrs'),
        '</div>'
      ].join(''));
    }

    var water = ae.water_section;
    if (water) {
      var wp = water.parameters || {};
      var ic = wp.inland_conveyance || {};
      parts.push([
        '<div class="hub-banner-row"><strong>Water Output</strong>' + chipPct(water.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Direct desal range', fmtK((wp.direct_desal_output_m3_day_range || [])[0]) + ' – ' + fmtK((wp.direct_desal_output_m3_day_range || [0, 0])[1]) + ' m³/day'),
        stat('Existing Bushehr', fmtK(wp.existing_bushehr_desal_m3_day) + ' m³/day'),
        stat('10-unit adds', fmtK(wp.deepfission_10unit_desal_m3_day) + ' m³/day'),
        stat('100-unit adds', fmtK(wp.deepfission_100unit_desal_m3_day) + ' m³/day'),
        '</div>',
        '<div class="hub-banner-row">',
        stat('Combined max', fmtK(wp.combined_max_m3_day) + ' m³/day'),
        stat('Salinity', (wp.coastal_intake_salinity_ppt_range || [37, 42]).join('–') + ' ppt Persian Gulf'),
        stat('Tehran distance', (ic.tehran_distance_km || '—') + ' km'),
        '</div>'
      ].join(''));
    }

    var dep = ae.deployment_section;
    if (dep) {
      var dp = dep.parameters || {};
      parts.push([
        '<div class="hub-banner-row"><strong>Local Deployment — Capital Ranges</strong>' + chipPct(dep.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Conversion facility', fmtM((dp.conversion_facility_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.conversion_facility_capex_usd_range || [0, 0])[1])),
        stat('DeepFission array', fmtM((dp.deepfission_array_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.deepfission_array_capex_usd_range || [0, 0])[1])),
        stat('MED coastal', fmtM((dp.med_desal_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.med_desal_capex_usd_range || [0, 0])[1])),
        stat('Inland conveyance', fmtM((dp.inland_conveyance_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.inland_conveyance_capex_usd_range || [0, 0])[1])),
        '</div>'
      ].join(''));
    }

    var scard = ae.scorecard_section;
    if (scard) {
      var wts = scard.weights || {};
      var wtList = Object.keys(wts).map(function (k) {
        return '<li><strong>' + wts[k] + '%</strong> ' + k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + '</li>';
      }).join('');
      parts.push([
        '<div class="hub-banner-row"><strong>Scorecard Weights</strong>' + chipPct(scard.confidence_percent) + '</div>',
        '<ul class="hub-banner-metrics">' + wtList + '</ul>'
      ].join(''));
    }

    var rep = ae.reporting_section;
    if (rep) {
      var metrics = (rep.required_metrics || []).map(function (m) { return '<li>' + m + '</li>'; }).join('');
      parts.push([
        '<div class="hub-banner-row"><strong>Reporting Requirements</strong>' + chipPct(rep.confidence_percent) + '</div>',
        '<ul class="hub-banner-metrics">' + metrics + '</ul>'
      ].join(''));
    }

    if (!parts.length) return;

    var container = document.createElement('div');
    container.id = 'hub-banners';
    container.className = 'hub-overview-gutter';
    container.innerHTML = parts.map(function (html) {
      return '<div class="hub-section-banner">' + html + '</div>';
    }).join('');
    anchor.replaceWith(container);
  }

  // ── Reset button & field change listeners ──────────────────────────────────
  function updateResetButtonVisibility(eventId) {
    var row = document.getElementById('hubResetRow');
    if (!row) return;
    row.hidden = Object.keys(getUserEdits(eventId)).length === 0;
  }

  function bindHubResetButton(data, eventId) {
    var btn = document.getElementById('hubResetBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      localStorage.removeItem(userEditsKey(eventId));
      seedCalculatorFields(data, eventId);
      updateResetButtonVisibility(eventId);
      if (typeof calculateNuclear === 'function') calculateNuclear();
    });
  }

  function bindFieldChangeListeners(data, eventId) {
    var ae = getAe(data);
    var yamlDefaults = safeGet(ae, 'engineering_section', 'parameters', 'calculator_defaults') || {};
    EDITABLE_FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        var diff = buildDiffFromFields(yamlDefaults);
        saveUserEdits(diff, eventId);
        updateResetButtonVisibility(eventId);
      });
    });
  }

  // ── Hub render (public — also used by space/index.html) ───────────────────
  function renderHub(data, eventId) {
    window.activeProjectEvent = data;
    var anchor = document.getElementById('project-hud-anchor');
    if (anchor) {
      var existing = document.getElementById('topinfo');
      if (existing) existing.remove();
      anchor.insertAdjacentHTML('afterend', buildHubMarkup(data));
      renderHubCharts(data);
      bindHubResetButton(data, eventId);
      bindFieldChangeListeners(data, eventId);
      updateResetButtonVisibility(eventId);
    }
    renderProjectOverview(data, eventId);
    renderAllSectionBanners(data, eventId);
  }

  window.renderEventHub = renderHub;

  // ── Load and render a single event ────────────────────────────────────────
  function clearOverview() {
    var ov = document.getElementById('projectOverview');
    if (ov) ov.innerHTML = '';
    if (ov) ov.hidden = false;
    var hub = document.getElementById('topinfo');
    if (hub) hub.remove();
    var link = document.getElementById('hud-scenario-data-link');
    if (link) link.hidden = true;
  }

  var _activeEventId = '';

  function loadAndRender(eventId) {
    _activeEventId = eventId;
    clearOverview();
    loadEventYaml(eventId)
      .then(function (data) {
        window.activeProjectEvent = data;
        seedCalculatorFields(data, eventId);
        renderHub(data, eventId);
        if (eventId === DEFAULT_EVENT) {
          var attempts = 0;
          var poll = setInterval(function () {
            if (typeof calculateNuclear === 'function') {
              clearInterval(poll);
              calculateNuclear();
            }
            if (++attempts > 50) clearInterval(poll);
          }, 100);
        }
      })
      .catch(function (err) {
        console.warn('[event-hub] Failed to load ' + eventId + '.yaml:', err);
        var ov = document.getElementById('projectOverview');
        if (ov) ov.innerHTML = '<div style="padding:16px 24px;color:var(--ink-2);">Could not load event data for <strong>' + eventId + '</strong>.</div>';
        var link = document.getElementById('hud-scenario-data-link');
        if (link) link.hidden = true;
      });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    var eventId = getActiveEventId();
    if (eventId) {
      loadAndRender(eventId);
    }

    document.addEventListener('hashChangeEvent', function () {
      var hash = typeof getHash === 'function' ? getHash() : {};
      var newId = (hash.event || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (newId === _activeEventId) return;
      if (newId) {
        loadAndRender(newId);
      } else {
        _activeEventId = '';
        clearOverview();
      }
    });
  }

  // Fire as soon as DOM is available — try three approaches to ensure it runs
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    // DOM already ready (e.g. script loaded dynamically)
    boot();
  }

})();
