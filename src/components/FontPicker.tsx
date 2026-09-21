import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../api";
import {
  mergeFontFamilies,
  quoteFontFamily,
  readerFontFamilyOf,
  readerFontIdOf,
} from "../lib/readerFont";
import { clampToViewport } from "../lib/viewport";
import { useDismiss } from "../hooks/useDismiss";
import { NO_AUTOCORRECT } from "../lib/inputProps";
import Icon from "./Icon";

/** How many families to render at once — a host can have thousands installed,
 *  and an unbounded list janks the scroll. The filter narrows it well below
 *  this in practice. */
const MAX_ROWS = 60;

/** Panel footprint for the viewport clamp below: `width` matches the CSS, and
 *  `height` is the search row (~31px), the list's 240px cap plus its padding,
 *  and the border. Same fixed-footprint approach as TagPicker. */
const PANEL_WIDTH = 250;
const PANEL_HEIGHT = 284;

/**
 * A combobox over the host's installed font families (plus the app's own
 * bundled typefaces), with a live preview of each option in its own font.
 *
 * The stored value is a family name (or one of the legacy enum ids, which
 * `readerFontFamilyOf` maps to the bundled family). An empty value is the app
 * default — shown as the "System" pseudo-entry rather than a blank row.
 */
export default function FontPicker({
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const fonts = useQuery({
    queryKey: ["system-fonts"],
    queryFn: api.listSystemFonts,
    staleTime: Infinity,
  });

  // A failed scan — a rejected `invoke`, e.g. a backend without the command —
  // still leaves the bundled families usable, so report it instead of taking
  // the control away from the user.
  useEffect(() => {
    if (fonts.isError) console.error("system font scan failed", fonts.error);
  }, [fonts.isError, fonts.error]);

  // Every entry the picker can offer: the app's bundled typefaces first (so an
  // install whose scan failed still shows them), then the host's families.
  const families = useMemo(() => mergeFontFamilies(fonts.data ?? []), [fonts.data]);

  const systemLabel = t("settings.reading.fontSystem");
  // The row the stored value points at, so reopening the list lands on it.
  const selectedFamily = readerFontFamilyOf(value);

  // `""` is the synthetic "System" row. It leads whenever it matches the query
  // — including an empty one — so the default stays reachable, but a query that
  // matches no family shows the empty hint rather than leaving it as the only
  // row to press Enter on.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = families.filter((f) => !q || f.toLowerCase().includes(q));
    const system = !q || systemLabel.toLowerCase().includes(q);
    return (system ? ["", ...matches] : matches).slice(0, MAX_ROWS);
  }, [families, query, systemLabel]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  /** Closing from a key press hands focus back to the trigger: the search input
   *  is about to unmount, and the trigger sits inside the Settings dialog's
   *  focus trap while the portalled panel does not. Pointer dismissals keep
   *  whatever focus the click gave the element underneath. */
  const closeFromKeyboard = useCallback(() => {
    closePanel();
    triggerRef.current?.focus();
  }, [closePanel]);

  // Outside click / focus-out dismissal, as everywhere else: the panel is
  // portalled out of `rootRef`, so it is handed over as an owned subtree.
  useDismiss(rootRef, closePanel, { enabled: open, portalRef: popRef });

  // The Settings dialog claims Escape with a window-level *capture* listener,
  // so a handler on the input can never run first. The dialog yields Escape to
  // any element marked `data-owns-escape` (see SettingsDialog), which is what
  // lets this listener close just the panel — a second Escape closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      closeFromKeyboard();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, closeFromKeyboard]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row visible as arrow keys move it. The panel is
  // portalled, so `scrollIntoView` would scroll the *window*; scroll the list.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !open) return;
    const row = list.children[active] as HTMLElement | undefined;
    if (!row) return;
    const overTop = row.offsetTop - list.offsetTop;
    const overBottom = overTop + row.offsetHeight - list.clientHeight;
    if (overBottom > 0) list.scrollTop += overBottom;
    else if (overTop < list.scrollTop) list.scrollTop = overTop;
  }, [active, open, rows.length]);

  // The panel is portalled to <body> because `.settings-scroll` is a
  // `contain: layout paint` box once it starts scrolling — a fixed-position
  // descendant would be laid out against it and clip the dropdown's lower rows.
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setPopPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const place = () => {
      const r = trigger.getBoundingClientRect();
      // Clamp with the shared two-sided helper: anchored just under the
      // trigger, the panel would otherwise spill past the window's bottom (or
      // its right edge in a narrow window) with its rows unreachable.
      setPopPos(
        clampToViewport({
          x: r.left,
          y: r.bottom + 5,
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
          margin: 8,
        }),
      );
    };
    place();
    // A scroll anywhere above (the settings list itself scrolls) or a resize
    // moves the trigger; follow both. Dismissal stays with useDismiss.
    const follow = () => place();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);

  const commit = (family: string) => {
    // The bundled entries are stored under their legacy ids so an install that
    // predates the picker keeps resolving; a host family is stored verbatim.
    onChange(readerFontIdOf(family));
    closeFromKeyboard();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const last = rows.length - 1;
      if (last < 0) return;
      setActive((a) =>
        e.key === "ArrowDown" ? (a >= last ? 0 : a + 1) : a <= 0 ? last : a - 1,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Nothing highlighted means the query matched nothing. Committing here
      // would fall back to the leading default row and silently reset the font.
      const family = rows[active];
      if (family !== undefined) commit(family);
      return;
    }
    if (e.key === "Tab") {
      // Let the default Tab action run on from the trigger, so the dialog's
      // focus trap resumes inside its own subtree.
      closeFromKeyboard();
    }
  };

  return (
    <div className={`font-picker ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`font-picker-trigger s-select ${value ? "has-reset" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className="font-picker-name"
          style={selectedFamily ? { fontFamily: quoteFontFamily(selectedFamily) } : undefined}
        >
          {selectedFamily || systemLabel}
        </span>
      </button>
      {/* A sibling rather than a nested span: a button inside a button is
          invalid, and the reset needs to be its own focus stop. */}
      {value && (
        <button
          type="button"
          className="font-picker-reset"
          aria-label={t("settings.reading.fontReset")}
          title={t("settings.reading.fontReset")}
          onClick={() => {
            onChange("");
            closeFromKeyboard();
          }}
        >
          <Icon name="x" size={11} />
        </button>
      )}
      {open && popPos && createPortal(
        <div
          className="font-picker-pop"
          ref={popRef}
          style={{ top: popPos.top, left: popPos.left }}
          data-owns-escape=""
        >
          <input
            ref={inputRef}
            className="font-picker-search"
            type="text"
            role="combobox"
            aria-label={ariaLabel ?? t("settings.reading.bodyFont")}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[active] !== undefined ? optionId(active) : undefined}
            placeholder={t("settings.reading.fontSearch")}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            {...NO_AUTOCORRECT}
          />
          {rows.length === 0 ? (
            <div className="font-picker-empty">
              {t("settings.reading.fontEmpty")}
            </div>
          ) : (
            <div className="font-picker-list" id={listId} ref={listRef} role="listbox">
              {rows.map((family, i) => (
                <div
                  key={family || "system"}
                  id={optionId(i)}
                  className={`font-picker-row ${i === active ? "active" : ""} ${
                    family === selectedFamily ? "selected" : ""
                  }`}
                  role="option"
                  aria-selected={family === selectedFamily}
                  style={family ? { fontFamily: quoteFontFamily(family) } : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(family);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  {family || systemLabel}
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
