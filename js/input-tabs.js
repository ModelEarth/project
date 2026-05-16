(function () {
  var INPUT_TABS = {
    overview: { name: 'Overview' },
    fields:   { name: 'Fields' },
    yaml:     { name: 'Yaml' },
    notes:    { name: 'Notes' },
    all:      { name: 'All' },
  };

  var _mode = 'overview';

  function safeGetHash() {
    if (typeof getHash === 'function') return getHash();
    var h = window.location.hash.replace(/^#/, '');
    return h.split('&').reduce(function (acc, pair) {
      var parts = pair.split('=');
      if (parts[0]) acc[parts[0]] = decodeURIComponent(parts[1] || '');
      return acc;
    }, {});
  }

  function safeGoHash(update) {
    if (typeof goHash === 'function') { goHash(update); return; }
    var h = safeGetHash();
    Object.assign(h, update);
    var next = Object.keys(h)
      .filter(function (k) { return h[k] !== undefined && h[k] !== null && h[k] !== ''; })
      .map(function (k) { return k + '=' + encodeURIComponent(h[k]); })
      .join('&');
    window.location.hash = next;
  }

  function resolveInputMode(value) {
    if (!value) return 'overview';
    var normalized = String(value).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(INPUT_TABS, normalized) ? normalized : 'all';
  }

  function renderInputTabs(opts) {
    opts = opts || {};
    var container = document.getElementById('inputTabsContainer');
    if (!container) return;
    var hash = safeGetHash();
    var mode = resolveInputMode(hash.input);
    var hasNotes = Boolean(opts.hasNotes);
    if (mode === 'notes' && !hasNotes) mode = 'overview';
    _mode = mode;

    var html = ['<div class="page-tab-container">'];
    Object.keys(INPUT_TABS).forEach(function (key) {
      if (key === 'notes' && !hasNotes) return;
      var active = key === mode ? ' active' : '';
      html.push(
        '<button class="page-tab' + active + '" id="input-' + key + '-tab" type="button" data-input="' + key + '">' +
        INPUT_TABS[key].name + '</button>'
      );
    });
    html.push('</div><div class="page-tab-line"></div>');
    container.innerHTML = html.join('');

    container.querySelectorAll('.page-tab[data-input]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        safeGoHash({ input: tab.getAttribute('data-input') || 'overview' });
      });
    });
  }

  // opts: { hasYaml, hasNotes, hasSave, isDirty, savedMessage }
  function applyInputSectionVisibility(opts) {
    opts = opts || {};
    var mode     = _mode;
    var showAll  = mode === 'all';
    var hasYaml  = Boolean(opts.hasYaml);
    var hasNotes = Boolean(opts.hasNotes);

    var overview = document.getElementById('overviewSection');
    var fields   = document.getElementById('detailConfig');
    var yaml     = document.getElementById('rawConfigSection');
    var notes    = document.getElementById('adminNoteSection');

    if (overview) overview.classList.toggle('is-hidden', !(showAll || mode === 'overview'));
    if (fields)   fields.classList.toggle('is-hidden',   !(showAll || mode === 'fields'));
    if (yaml)     yaml.classList.toggle('is-hidden',     !(hasYaml && (showAll || mode === 'yaml')));
    if (notes)    notes.classList.toggle('is-hidden',    !(hasNotes && (showAll || mode === 'notes')));

    var save = document.getElementById('rawConfigSaveSection');
    if (save && opts.hasSave) {
      var isDirty     = Boolean(opts.isDirty);
      var inSaveViews = showAll || mode === 'fields' || mode === 'yaml';
      var savedOnly   = !isDirty && opts.savedMessage === 'Saved config.yaml';
      save.classList.toggle('is-hidden', !(inSaveViews && (isDirty || savedOnly)));
      var saveBtn = document.getElementById('saveRawConfig');
      if (saveBtn) saveBtn.classList.toggle('is-hidden', !isDirty);
    }
  }

  function getMode() { return _mode; }

  window.InputTabs = {
    INPUT_TABS: INPUT_TABS,
    resolveInputMode: resolveInputMode,
    renderInputTabs: renderInputTabs,
    applyInputSectionVisibility: applyInputSectionVisibility,
    getMode: getMode,
  };
})();
