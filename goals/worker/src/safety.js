// Safety layer: runs before any tool on free text. Matching is deliberately
// broad; a false positive shows crisis lines unnecessarily, which is the
// acceptable error.

export function checkSafety(profile, text) {
  return profile.safety.patterns.some((re) => re.test(text));
}

export function safetyBlock(profile) {
  return { message: profile.safety.message, lines: profile.safety.lines, priority: "show_first" };
}
