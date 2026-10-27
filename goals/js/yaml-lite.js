// A small reader for the event YAML files (project/events/<id>.yaml), shared by
// the goals page (when localsite's YAML parser isn't loaded) and the goals
// Worker, which has no dependencies. It reads top-level text fields, top-level
// lists of flat items (hero_images, safety_lines) and flat nested mappings.
// Nested lists and multi-line strings are not supported.
export function parseYamlLite(text) {
  const out = {};
  const unquote = (v) => v.replace(/^(['"])(.*)\1$/, "$2");
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (top) {
      key = null;
      if (top[2] && !top[2].startsWith("#")) out[top[1]] = unquote(top[2]);
      else if (!top[2]) key = top[1];
      continue;
    }
    const item = key && line.match(/^\s+(-\s+)?([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/);
    if (!item) continue;
    if (item[1]) (out[key] ||= []).push({});
    const target = Array.isArray(out[key]) ? out[key][out[key].length - 1] : (out[key] ||= {});
    target[item[2]] = unquote(item[3]);
  }
  return out;
}
