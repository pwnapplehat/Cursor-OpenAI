/**
 * Rough, approximate token count used only as a last-resort fallback when a
 * Cursor run does not report real token usage (the SDK docs note usage is
 * "absent when none did"). This is a coarse ~4-characters-per-token heuristic,
 * NOT a real tokenizer - callers must not treat it as billing-accurate. It
 * exists so `usage` is never entirely missing from an OpenAI-shaped response,
 * which some client libraries assume is always present.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
