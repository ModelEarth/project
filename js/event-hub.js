/* event-hub.js — loads iran-energy.yaml and renders #hub panel + section banners */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var YAML_PATH      = './events/iran-energy.yaml';
  var YAML_FALLBACK  = '../events/iran-energy.yaml';
  var USER_EDITS_KEY = 'iranEnergyUserEditsV1';

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

  // ── YAML fetch with fallback ───────────────────────────────────────────────
  function loadEventYaml() {
    function tryFetch(url) {
      return fetch(url, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
          return r.text();
        });
    }
    return tryFetch(YAML_PATH)
      .catch(function () { return tryFetch(YAML_FALLBACK); })
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
  function getUserEdits() {
    try { return JSON.parse(localStorage.getItem(USER_EDITS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function saveUserEdits(edits) {
    try {
      if (Object.keys(edits).length) {
        localStorage.setItem(USER_EDITS_KEY, JSON.stringify(edits));
      } else {
        localStorage.removeItem(USER_EDITS_KEY);
      }
    } catch (_) {}
  }

  // ── Calculator field seeding ───────────────────────────────────────────────
  function seedCalculatorFields(data) {
    var ae = getAe(data);
    var defaults = safeGet(ae, 'engineering_section', 'parameters', 'calculator_defaults') || {};
    var userEdits = getUserEdits();
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
    var startYear   = data.start_date ? data.start_date.slice(0, 4) : '';
    var endYear     = data.end_date   ? data.end_date.slice(0, 4)   : '';

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
        ((startYear || endYear) ? '<div class="hub-phase-pill" style="opacity:.55">' + startYear + '–' + endYear + '</div>' : '') +
        '</div>';
    }

    var html = '';
    html += '<div id="hub" class="event-hub-panel">';

    // Identity bar
    html += '<div class="hub-identity-bar">';
    html += '<span class="hub-mission-name"><span class="material-icons" style="color:var(--hero-1);font-size:20px">hub</span>' + missionName + '</span>';
    if (phaseText) html += '<span class="hub-phase-text">' + phaseText + '</span>';
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
        grid: { left: 14, right: 14, top: 12, bottom: 54 },
        xAxis: { type: 'category', data: phases, axisLabel: { fontSize: 9, rotate: 12 } },
        yAxis: { type: 'value', name: 'USD B', axisLabel: { fontSize: 10, formatter: '${value}B' } },
        color: ['transparent', '#0f7173'],
        series: [
          { type: 'bar', stack: 'rng', data: costMins,   itemStyle: { color: 'transparent' }, tooltip: { show: false } },
          { type: 'bar', stack: 'rng', data: costRanges, itemStyle: { color: '#0f7173', opacity: 0.75 }, barWidth: '52%' }
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
  }

  window.resizeHubCharts = resizeHubCharts;

  // ── Section banners ────────────────────────────────────────────────────────
  function renderSectionBanner(sectionId, html) {
    var section = document.getElementById(sectionId);
    if (!section) return;
    var target = section.querySelector('.panel-body') || section;
    var existing = section.querySelector('.hub-section-banner');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.className = 'hub-section-banner';
    div.innerHTML = html;
    target.prepend(div);
  }

  function stat(label, value) {
    return '<span class="hub-stat"><span class="hub-stat-label">' + label + ':</span> <span class="hub-stat-value">' + value + '</span></span>';
  }

  function chipPct(pct) {
    return '<span class="hub-confidence-chip">' + fmtPct(pct) + ' confidence</span>';
  }

  function renderAllSectionBanners(data) {
    var ae = getAe(data);

    // Studio
    var studio = ae.studio_section;
    if (studio) {
      var sp = studio.scenario_parameters || {};
      renderSectionBanner('studio', [
        '<div class="hub-banner-row"><strong>Iran Energy Corridor — Scenario Parameters</strong>' + chipPct(studio.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Sponsor value/yr', fmtM((sp.sponsor_annual_value_range_usd || [])[0]) + ' – ' + fmtM((sp.sponsor_annual_value_range_usd || [0, 0])[1])),
        stat('Households', (((sp.households_supported_range || [])[0] || 0) / 1e3 | 0) + 'K – ' + ((((sp.households_supported_range || [0, 0])[1]) || 0) / 1e3 | 0) + 'K'),
        stat('Energy portfolio', ((((sp.energy_portfolio_mwh_year_range || [])[0] || 0) / 1e6).toFixed(1)) + 'M – ' + (((sp.energy_portfolio_mwh_year_range || [0, 0])[1] || 0) / 1e6).toFixed(0) + 'M MWh/yr'),
        stat('Water revenue/yr', fmtM((sp.annual_water_revenue_range_usd || [])[0]) + ' – ' + fmtM((sp.annual_water_revenue_range_usd || [0, 0])[1])),
        '</div>'
      ].join(''));
    }

    // Benefits
    var ben = ae.benefits_section;
    if (ben) {
      var bp = ben.parameters || {};
      renderSectionBanner('benefits', [
        '<div class="hub-banner-row"><strong>Corridor Benefits — Iran Scenario</strong>' + chipPct(ben.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Pure water coverage', (bp.pure_water_coverage_percent_range || [5, 55]).join('–') + '%'),
        stat('Daily water output', fmtK((bp.daily_pure_water_output_m3_day_range || [])[0]) + ' – ' + fmtK((bp.daily_pure_water_output_m3_day_range || [0, 0])[1]) + ' m³/day'),
        stat('Carbon value', '$' + (bp.carbon_value_per_tonne_usd_range || [15, 120]).join('–') + '/tonne CO₂'),
        stat('Process water savings', '$' + (bp.process_water_savings_per_m3_usd_range || [0.4, 3.2]).join('–') + '/m³'),
        '</div>'
      ].join(''));
    }

    // Engineering (Deep Nuclear)
    var eng = ae.engineering_section;
    if (eng) {
      var ep = eng.parameters || {};
      var dfu = ep.deep_fission_reference_unit || {};
      var eo = ep.calculator_expected_output || {};
      renderSectionBanner('engineering', [
        '<div class="hub-banner-row"><strong>DEEP Nuclear for Water Replenishment</strong>' + chipPct(eng.confidence_percent) + '<span class="hub-seeded-note"><span class="material-icons">check_circle</span>Calculator inputs seeded from iran-energy.yaml</span></div>',
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

    // Water Output
    var water = ae.water_section;
    if (water) {
      var wp = water.parameters || {};
      var ic = wp.inland_conveyance || {};
      renderSectionBanner('water', [
        '<div class="hub-banner-row"><strong>Water Output — Iran Desal Scenario</strong>' + chipPct(water.confidence_percent) + '</div>',
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

    // Deployment
    var dep = ae.deployment_section;
    if (dep) {
      var dp = dep.parameters || {};
      renderSectionBanner('deployment', [
        '<div class="hub-banner-row"><strong>Local Deployment — Capital Ranges</strong>' + chipPct(dep.confidence_percent) + '</div>',
        '<div class="hub-banner-row">',
        stat('Conversion facility', fmtM((dp.conversion_facility_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.conversion_facility_capex_usd_range || [0, 0])[1])),
        stat('DeepFission array', fmtM((dp.deepfission_array_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.deepfission_array_capex_usd_range || [0, 0])[1])),
        stat('MED coastal', fmtM((dp.med_desal_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.med_desal_capex_usd_range || [0, 0])[1])),
        stat('Inland conveyance', fmtM((dp.inland_conveyance_capex_usd_range || [])[0]) + ' – ' + fmtM((dp.inland_conveyance_capex_usd_range || [0, 0])[1])),
        '</div>'
      ].join(''));
    }

    // Scorecard
    var scard = ae.scorecard_section;
    if (scard) {
      var wts = scard.weights || {};
      var wtList = Object.keys(wts).map(function (k) {
        return '<li><strong>' + wts[k] + '%</strong> ' + k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + '</li>';
      }).join('');
      renderSectionBanner('scorecard', [
        '<div class="hub-banner-row"><strong>Scorecard Weights — Iran Energy Corridor</strong>' + chipPct(scard.confidence_percent) + '</div>',
        '<ul class="hub-banner-metrics">' + wtList + '</ul>'
      ].join(''));
    }

    // Reporting
    var rep = ae.reporting_section;
    if (rep) {
      var metrics = (rep.required_metrics || []).map(function (m) { return '<li>' + m + '</li>'; }).join('');
      renderSectionBanner('reporting', [
        '<div class="hub-banner-row"><strong>Project Reporting Requirements</strong>' + chipPct(rep.confidence_percent) + '</div>',
        '<ul class="hub-banner-metrics">' + metrics + '</ul>'
      ].join(''));
    }
  }

  // ── Reset button & field change listeners ──────────────────────────────────
  function updateResetButtonVisibility() {
    var row = document.getElementById('hubResetRow');
    if (!row) return;
    row.hidden = Object.keys(getUserEdits()).length === 0;
  }

  function bindHubResetButton(data) {
    var btn = document.getElementById('hubResetBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      localStorage.removeItem(USER_EDITS_KEY);
      seedCalculatorFields(data);
      updateResetButtonVisibility();
      if (typeof calculateNuclear === 'function') calculateNuclear();
    });
  }

  function bindFieldChangeListeners(data) {
    var ae = getAe(data);
    var yamlDefaults = safeGet(ae, 'engineering_section', 'parameters', 'calculator_defaults') || {};
    EDITABLE_FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        var diff = buildDiffFromFields(yamlDefaults);
        saveUserEdits(diff);
        updateResetButtonVisibility();
      });
    });
  }

  // ── Hub render (public — also used by space/index.html) ───────────────────
  function renderHub(data) {
    window.activeProjectEvent = data;
    var anchor = document.getElementById('project-hud-anchor');
    if (anchor) {
      var existing = document.getElementById('hub');
      if (existing) existing.remove();
      anchor.insertAdjacentHTML('afterend', buildHubMarkup(data));
      renderHubCharts(data);
      bindHubResetButton(data);
      bindFieldChangeListeners(data);
      updateResetButtonVisibility();
    }
    renderAllSectionBanners(data);
  }

  window.renderEventHub = renderHub;

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    loadEventYaml()
      .then(function (data) {
        window.activeProjectEvent = data;
        seedCalculatorFields(data);
        renderHub(data);
        // Re-run nuclear calculator with seeded values
        var attempts = 0;
        var poll = setInterval(function () {
          if (typeof calculateNuclear === 'function') {
            clearInterval(poll);
            calculateNuclear();
          }
          if (++attempts > 50) clearInterval(poll);
        }, 100);
      })
      .catch(function (err) {
        console.warn('[event-hub] Failed to load iran-energy.yaml:', err);
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
