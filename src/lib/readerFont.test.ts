// Unit tests for the reader-font preference helpers.
// `readerFont.ts` is pure — no DOM, no backend — so this runs in the node
// environment alongside the other `src/lib` tests.

import { describe, it, expect } from "vitest";
import {
  BUNDLED_READER_FONTS,
  mergeFontFamilies,
  migrateReaderFont,
  quoteFontFamily,
  readerFontFamilyOf,
  readerFontIdOf,
  readerFontStackOf,
} from "./readerFont";

describe("readerFontStackOf", () => {
  it("maps the app default and the legacy serif id to the serif stack", () => {
    expect(readerFontStackOf("")).toBe("var(--serif)");
    expect(readerFontStackOf("serif")).toBe("var(--serif)");
  });

  it("maps the remaining legacy ids to their built-in stacks", () => {
    expect(readerFontStackOf("sans")).toBe("var(--ui)");
    expect(readerFontStackOf("hyperlegible")).toBe(
      "'Atkinson Hyperlegible', var(--ui)",
    );
  });

  it("treats anything else as a host family name and quotes it", () => {
    // A multi-word family must arrive as a single quoted family, not as a
    // three-family fallback list.
    expect(readerFontStackOf("PingFang SC")).toBe("'PingFang SC'");
  });
});

describe("quoteFontFamily", () => {
  it("quotes a plain name", () => {
    expect(quoteFontFamily("Helvetica")).toBe("'Helvetica'");
  });

  it("drops quotes and backslashes rather than letting them escape", () => {
    // `'Foo\'` would swallow the closing quote and invalidate the CSS value.
    expect(quoteFontFamily("Foo\\")).toBe("'Foo'");
    expect(quoteFontFamily("O'Neil")).toBe("'ONeil'");
  });
});

describe("readerFontFamilyOf / readerFontIdOf", () => {
  it("round-trips the pinned enum ids and family names", () => {
    for (const { id, family } of BUNDLED_READER_FONTS) {
      expect(readerFontFamilyOf(id)).toBe(family);
      expect(readerFontIdOf(family)).toBe(id);
    }
  });

  it("passes a host family through unchanged", () => {
    expect(readerFontFamilyOf("Helvetica")).toBe("Helvetica");
    expect(readerFontIdOf("Helvetica")).toBe("Helvetica");
  });

  it("leaves the app default empty on both sides", () => {
    expect(readerFontFamilyOf("")).toBe("");
    expect(readerFontIdOf("")).toBe("");
  });
});

describe("mergeFontFamilies", () => {
  it("leads with the bundled typefaces and appends host families", () => {
    expect(mergeFontFamilies(["Helvetica", "Zed"])).toEqual([
      "Newsreader Variable",
      "Inter Tight Variable",
      "Atkinson Hyperlegible",
      "Helvetica",
      "Zed",
    ]);
  });

  it("keeps a bundled family once when the host also reports it", () => {
    const merged = mergeFontFamilies(["Inter Tight Variable", "Helvetica"]);
    expect(merged.filter((f) => f === "Inter Tight Variable")).toHaveLength(1);
  });

  it("drops duplicates and empty entries from the host list", () => {
    expect(mergeFontFamilies(["", "Helvetica", "Helvetica"])).toEqual([
      ...BUNDLED_READER_FONTS.map((f) => f.family),
      "Helvetica",
    ]);
  });

  it("still offers the bundled families when the scan returned nothing", () => {
    expect(mergeFontFamilies([])).toEqual(BUNDLED_READER_FONTS.map((f) => f.family));
  });
});

describe("migrateReaderFont", () => {
  it("keeps any stored value, legacy ids and host families alike", () => {
    expect(migrateReaderFont("sans", null)).toBe("sans");
    expect(migrateReaderFont("Helvetica", null)).toBe("Helvetica");
  });

  it("migrates the pre-0.2 boolean toggle when nothing is stored", () => {
    // `useSerif === "0"` meant "not the serif" → the UI font.
    expect(migrateReaderFont(null, "0")).toBe("sans");
    expect(migrateReaderFont(null, "1")).toBe("");
    expect(migrateReaderFont(null, null)).toBe("");
  });

  it("prefers the stored value over the legacy toggle", () => {
    expect(migrateReaderFont("Helvetica", "0")).toBe("Helvetica");
  });
});
