// The accent per (palette, mode), fed to --accent / --accent-soft /
// --accent-ink. Shared by App.tsx (applies them to the document root) and the
// Settings palette previews (each preview card re-declares them so its
// data-palette subtree reads the right accent regardless of the active theme).
// `accent` is the mark, `soft` the active-row/selection wash, `ink` text on
// that wash. One accent, used rarely — it only ever tints small marks.

import type { Palette, ResolvedMode } from "../store";

export interface PaletteAccent {
  accent: string;
  soft: string;
  ink: string;
}

export const ACCENTS: Record<Palette, Record<ResolvedMode, PaletteAccent>> = {
  paper: {
    light: { accent: "oklch(0.60 0.13 38)", soft: "oklch(0.94 0.04 50)", ink: "oklch(0.42 0.10 38)" },
    dark: { accent: "oklch(0.74 0.13 45)", soft: "oklch(0.32 0.06 40)", ink: "oklch(0.80 0.10 45)" },
  },
  frost: {
    light: { accent: "#007AFF", soft: "rgba(0, 122, 255, 0.13)", ink: "#0062CC" },
    dark: { accent: "#0A84FF", soft: "rgba(10, 132, 255, 0.20)", ink: "#6FB4FF" },
  },
  contrast: {
    light: { accent: "#0057D9", soft: "rgba(0, 87, 217, 0.14)", ink: "#003E9E" },
    dark: { accent: "#0A84FF", soft: "rgba(10, 132, 255, 0.24)", ink: "#8CC4FF" },
  },
  forest: {
    light: { accent: "#2F5D3A", soft: "rgba(47, 93, 58, 0.12)", ink: "#24492D" },
    dark: { accent: "#5B9B6A", soft: "rgba(91, 155, 106, 0.18)", ink: "#8EC49B" },
  },
  mint: {
    light: { accent: "#2E8F7A", soft: "rgba(46, 143, 122, 0.12)", ink: "#237060" },
    dark: { accent: "#4CB39A", soft: "rgba(76, 179, 154, 0.18)", ink: "#7FD0BD" },
  },
  bee: {
    light: { accent: "#A8862B", soft: "rgba(168, 134, 43, 0.14)", ink: "#7E641F" },
    dark: { accent: "#D4B84A", soft: "rgba(212, 184, 74, 0.16)", ink: "#E8D078" },
  },
  parchment: {
    light: { accent: "#C45A32", soft: "rgba(196, 90, 50, 0.12)", ink: "#9C4422" },
    dark: { accent: "#E08A5F", soft: "rgba(224, 138, 95, 0.16)", ink: "#F0B08C" },
  },
};
