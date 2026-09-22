// Pure gate for whether an article body is worth offering an AI summary on.
// Kept free of DOM/Tauri imports so the rule is unit-testable in a plain node
// environment (vitest only collects src/lib/**/*.test.ts; the Reader component
// that consumes this deliberately isn't in that glob).

/** Below this many plain-text characters the body is a one-line link post —
 *  no substance to condense, regardless of language. */
export const SUMMARY_MIN_CHARS = 100;

/** Below this many CJK characters a body that is otherwise long enough is
 *  still mostly English/punctuation/space — short Chinese posts pad past
 *  SUMMARY_MIN_CHARS with foreign words (v2ex #1243927: 114 chars, 49 hanzi). */
export const SUMMARY_MIN_HANZI = 100;

/** A body with at least this fraction of hanzi is "Chinese enough" that the
 *  hanzi floor applies. Guards the reverse mis-hit: a 3600-char English essay
 *  that happens to contain two Chinese characters stays visible. */
export const SUMMARY_HANZI_SHARE = 0.2;

const HANZI = /[㐀-䶿一-鿿豈-﫿]/g;

/**
 * True when the plain-text body is too short (or too thinly Chinese) for a
 * model summary to earn its place. Hide when either:
 *   - total length < SUMMARY_MIN_CHARS, or
 *   - it has some hanzi, hanzi < SUMMARY_MIN_HANZI, and hanzi are ≥
 *     SUMMARY_HANZI_SHARE of the text (short Chinese post).
 * Long English (hanzi = 0) and long Chinese (hanzi ≥ floor) both pass.
 */
export function summaryTooShort(plain: string): boolean {
  const text = plain.trim();
  if (text.length < SUMMARY_MIN_CHARS) return true;
  const hanzi = text.match(HANZI)?.length ?? 0;
  return (
    hanzi > 0 &&
    hanzi < SUMMARY_MIN_HANZI &&
    hanzi / text.length >= SUMMARY_HANZI_SHARE
  );
}
