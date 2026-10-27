// Settings that belong with an event rather than in code: a profile names its
// event (profile.event), and its YAML (project/events/<event>.yaml) supplies
// the safety_lines. Read through the ASSETS binding once per isolate; a failed
// read is retried on the next request.

import { parseYamlLite } from "../../js/yaml-lite.js";
import { assetText } from "./sources.js";

// Used only while the event file can't be read, so a crisis response always
// carries at least this line.
const FALLBACK_LINES = [{ name: "Emergency", how: "Call 911 if there is immediate danger", channel: "phone", value: "911" }];
const loaded = new Set();

// The events folder sits beside the goals folder: /events standalone,
// /project/events in CloudRoot. EVENTS_PREFIX overrides it.
export function eventsPrefix(env) {
  return env.EVENTS_PREFIX ?? `${(env.DATA_PREFIX || "").replace(/\/goals$/, "")}/events`;
}

export async function loadProfileEvent(env, profile) {
  if (!profile.event || loaded.has(profile.id)) return;
  try {
    const ev = parseYamlLite(await assetText(env, `${eventsPrefix(env)}/${profile.event}.yaml`));
    const lines = (Array.isArray(ev.safety_lines) ? ev.safety_lines : []).filter((l) => l.name && l.how);
    if (!lines.length) throw new Error("no safety_lines");
    profile.safety.lines = lines;
    loaded.add(profile.id);
  } catch (err) {
    console.warn(`[goals] events/${profile.event}.yaml: ${err.message}`);
    if (!profile.safety.lines.length) profile.safety.lines = FALLBACK_LINES;
  }
}
