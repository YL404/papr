// Reader typeface resolution — the pure half of the reader-font preference:
// which typefaces the app itself ships, the CSS stack a stored value maps to,
// and the migration of the values older installs persisted.
//
// Kept out of `store.ts` (which pulls in the backend API and i18n) so it can be
// unit-tested in the node environment like the other `src/lib` helpers.

/** A built-in reader typeface: the id older installs persisted, and the family
 *  name the reader renders it with. */
export interface BundledReaderFont {
  id: string;
  family: string;
}

/** The reader typefaces the app itself provides.
 *
 *  `serif` / `sans` ship inside the bundle through `@fontsource-variable` (see
 *  `src/main.tsx`), so they resolve on any host. `hyperlegible` is served by the
 *  Google Fonts stylesheet in `index.html` — it needs the network, which is why
 *  its stack ends in `var(--ui)`: an offline host degrades to the UI font
 *  instead of a serif. The family names must match the stacks in
 *  `src/styles.css`, and the ids are the pre-picker enum that installations
 *  upgrading from an older build still have in localStorage. */
export const BUNDLED_READER_FONTS: BundledReaderFont[] = [
  { id: "serif", family: "Newsreader Variable" },
  { id: "sans", family: "Inter Tight Variable" },
  { id: "hyperlegible", family: "Atkinson Hyperlegible" },
];

/** A family name as a single-quoted CSS string. Quotes and backslashes are
 *  dropped rather than escaped: they would end the string early (`Foo\` would
 *  swallow the closing quote and invalidate the whole value), and no real
 *  family name contains either — so `'PingFang SC'` stays one family. */
export function quoteFontFamily(family: string): string {
  return `'${family.replace(/['\\]/g, "")}'`;
}

/** Resolve a persisted reader font to the CSS stack the `--reader-font` CSS
 *  variable holds. An empty value is the app default; a legacy enum id maps to
 *  its built-in stack; anything else is a family name straight from the host's
 *  font list. */
export function readerFontStackOf(font: string): string {
  switch (font) {
    case "":
    case "serif":
      return "var(--serif)";
    case "sans":
      return "var(--ui)";
    case "hyperlegible":
      return "'Atkinson Hyperlegible', var(--ui)";
    default:
      return quoteFontFamily(font);
  }
}

/** The display name the picker shows for a stored value: the bundled entry's
 *  family name, or the raw family for a host font (`""` = the app default). */
export function readerFontFamilyOf(font: string): string {
  if (!font) return "";
  return BUNDLED_READER_FONTS.find((f) => f.id === font)?.family ?? font;
}

/** The value to persist for `family`: the bundled entries go in under their
 *  legacy id so the CSS stacks and older builds keep resolving them, a host
 *  family is stored verbatim, and `""` (the synthetic System row) stays `""`. */
export function readerFontIdOf(family: string): string {
  if (!family) return "";
  return BUNDLED_READER_FONTS.find((f) => f.family === family)?.id ?? family;
}

/** The picker's option list: the bundled typefaces lead — so an install whose
 *  font scan found nothing still offers them — followed by every host family
 *  not already listed, in the order the backend returned them (A–Z). */
export function mergeFontFamilies(host: readonly string[]): string[] {
  const seen = new Set(BUNDLED_READER_FONTS.map((f) => f.family));
  const merged = [...seen];
  for (const family of host) {
    if (family && !seen.has(family)) {
      seen.add(family);
      merged.push(family);
    }
  }
  return merged;
}

/** Resolve what to store on boot: a stored value wins (it is either a legacy
 *  enum id or a host family name), otherwise the pre-0.2 boolean `useSerif`
 *  toggle (serif on/off) is migrated to the named-typeface preference, and a
 *  fresh install starts on the app default (`""`). */
export function migrateReaderFont(
  stored: string | null,
  legacyUseSerif: string | null,
): string {
  if (stored) return stored;
  return legacyUseSerif === "0" ? "sans" : "";
}
