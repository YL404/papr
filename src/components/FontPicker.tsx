import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as api from "../api";
import {
  BUNDLED_READER_FONTS,
  readerFontFamilyOf,
} from "../store";
import { NO_AUTOCORRECT } from "../lib/inputProps";
import Icon from "./Icon";

/** How many families to render at once — a host can have thousands installed,
 *  and an unbounded list janks the scroll. The filter narrows it well below
 *  this in practice. */
const MAX_ROWS = 60;

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

  const fonts = useQuery({
    queryKey: ["system-fonts"],
    queryFn: api.listSystemFonts,
    staleTime: Infinity,
  });

  // Every entry the picker can offer: the app default first, then the bundled
  // built-ins (so an install whose font scan failed still shows the three app
  // typefaces), then the host's families. The default is a synthetic row —
  // committing it clears the stored value.
  const options = useMemo(() => {
    const host = fonts.data ?? [];
    const bundled = BUNDLED_READER_FONTS.map((f) => f.family);
    const seen = new Set(bundled);
    const merged = [...bundled];
    for (const f of host) {
      if (!seen.has(f)) {
        seen.add(f);
        merged.push(f);
      }
    }
    return merged;
  }, [fonts.data]);

  // `""` is the synthetic "System" row and always leads, even when a query
  // would otherwise filter it out — the default must stay reachable.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rest = options.filter((f) => !q || f.toLowerCase().includes(q));
    return ["", ...rest].slice(0, MAX_ROWS);
  }, [options, query]);

  // The row the stored value points at, so reopening the list lands on it.
  const selectedFamily = readerFontFamilyOf(value);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The panel is portalled to <body>, so it is not inside `rootRef` —
      // check it explicitly before treating a press as "outside".
      const inside =
        rootRef.current?.contains(e.target as Node) ||
        popRef.current?.contains(e.target as Node);
      if (!inside) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

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
  }, [active, open]);

  // The panel is portalled to <body> because `.settings-scroll` clips
  // absolutely-positioned descendants once it starts scrolling — without the
  // portal the dropdown's lower rows would be cut by the container edge.
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
      setPopPos({ top: r.bottom + 5, left: r.left });
    };
    place();
    // A scroll anywhere above (the settings list itself scrolls) shifts the
    // trigger; follow it. The close-on-outside-click handler below still owns
    // dismissal.
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open]);

  if (fonts.isError) {
    // A failed scan still leaves the bundled entries usable; report once,
    // outside render, so the retry can surface a fresh error.
    console.error("system font scan failed", fonts.error);
    return null;
  }

  const commit = (family: string) => {
    // The bundled entries are stored under their legacy ids so an install that
    // predates the picker keeps resolving; a host family is stored verbatim.
    const id =
      BUNDLED_READER_FONTS.find((f) => f.family === family)?.id ?? family;
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const reset = () => {
    onChange("");
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const last = filtered.length - 1;
      setActive((a) =>
        e.key === "ArrowDown" ? (a >= last ? 0 : a + 1) : a <= 0 ? last : a - 1,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open) commit(filtered[active] ?? "");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery("");
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div
      className={`font-picker ${open ? "open" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        ref={triggerRef}
        className="font-picker-trigger s-select"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          inputRef.current?.focus();
        }}
      >
        <span
          className="font-picker-name"
          style={selectedFamily ? { fontFamily: `'${selectedFamily}'` } : undefined}
        >
          {selectedFamily || t("settings.reading.fontSystem")}
        </span>
        {value && (
          <span
            className="font-picker-reset"
            role="button"
            tabIndex={0}
            title={t("settings.reading.fontReset")}
            onClick={(e) => {
              e.stopPropagation();
              reset();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                reset();
              }
            }}
          >
            <Icon name="x" size={11} />
          </span>
        )}
      </button>
      {open && popPos && createPortal(
        <div
          className="font-picker-pop"
          ref={popRef}
          style={{ top: popPos.top, left: popPos.left }}
        >
          <input
            ref={inputRef}
            className="font-picker-search"
            type="text"
            placeholder={t("settings.reading.fontSearch")}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            {...NO_AUTOCORRECT}
          />
          <div className="font-picker-list" ref={listRef} role="listbox">
            {filtered.map((family, i) => (
              <div
                key={family || "system"}
                className={`font-picker-row ${i === active ? "active" : ""} ${
                  family === selectedFamily ? "selected" : ""
                }`}
                role="option"
                aria-selected={family === selectedFamily}
                style={family ? { fontFamily: `'${family}'` } : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(family);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {family || t("settings.reading.fontSystem")}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="font-picker-empty">
                {t("settings.reading.fontEmpty")}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
