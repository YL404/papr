import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cloneElement, isValidElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import * as api from "../api";
import { useUi, READER_BOUNDS, type OpenMode } from "../store";
import { useArticleActions } from "../hooks/articleActions";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { LANGUAGES, setLanguage, type Language } from "../i18n";
import { feedHost } from "../lib/feedMeta";
import { modKey, modCombo } from "../lib/platform";
import { reportError } from "../toast";
import { downloadFile } from "../lib/download";
import { NO_AUTOCORRECT } from "../lib/inputProps";
import type {
  AiProfiles,
  AiProviderEntry,
  AiProviderKind,
  Feed,
} from "../types";
import Icon, { type IconName } from "./Icon";
import ConfirmDialog from "./ConfirmDialog";
import FeedAvatar from "./FeedAvatar";
import FontPicker from "./FontPicker";

interface Props {
  onClose: () => void;
  onToast: (msg: string) => void;
  initialSection?: string;
  onAddFeed: () => void;
}

// `labelKey` holds an i18n key — resolved with t() at render time. Nav icons
// stay monochrome (quiet ink, accent only on the active row) — one accent,
// used rarely, never a decorative rainbow of per-section colours.
const SECTIONS: { id: string; labelKey: string; icon: IconName }[] = [
  { id: "general", labelKey: "settings.nav.general", icon: "settings" },
  { id: "appearance", labelKey: "settings.nav.appearance", icon: "globe" },
  { id: "reading", labelKey: "settings.nav.reading", icon: "eye" },
  { id: "subscriptions", labelKey: "settings.nav.subscriptions", icon: "rss" },
  { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: "command" },
  { id: "notifications", labelKey: "settings.nav.notifications", icon: "inbox" },
  { id: "ai", labelKey: "settings.nav.ai", icon: "sparkle-fill" },
  { id: "advanced", labelKey: "settings.nav.advanced", icon: "sort" },
  { id: "about", labelKey: "settings.nav.about", icon: "sparkle" },
];

/** The app version read from the Tauri bundle config at runtime, cached so the
 *  one IPC round-trip is shared between the sidebar footer and the About pane.
 *  Sourcing it live keeps the displayed version from drifting out of sync with
 *  `tauri.conf.json` the way a hardcoded string does on every release bump. */
let versionPromise: Promise<string> | null = null;
function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    versionPromise ??= getVersion().catch(() => "");
    let live = true;
    versionPromise.then((v) => {
      if (live) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return version;
}

export default function SettingsDialog({
  onClose,
  onToast,
  initialSection,
  onAddFeed,
}: Props) {
  const { t } = useTranslation();
  // An explicit `initialSection` (a deep link, e.g. the palette's "Import
  // OPML") wins; otherwise reopen on the section the user last visited. The
  // saved id is validated against SECTIONS so a stale key from an older build
  // (section renamed or removed) falls back to "general" instead of landing on
  // an empty pane.
  const [section, setSection] = useState(() => {
    if (initialSection) return initialSection;
    const saved = localStorage.getItem("settingsSection");
    return saved != null && SECTIONS.some((s) => s.id === saved)
      ? saved
      : "general";
  });
  // Remember the section across dialog reopens.
  useEffect(() => {
    localStorage.setItem("settingsSection", section);
  }, [section]);
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: api.listFeeds });
  const windowRef = useRef<HTMLDivElement>(null);
  const version = useAppVersion();
  useFocusTrap(windowRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A nested popover that marks itself (the font picker's dropdown) owns
      // Escape while it is open: one press closes the popover, the next one
      // closes the dialog. Without this the capture phase below would shut the
      // whole dialog before the popover could ever see the key.
      if (document.querySelector("[data-owns-escape]")) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const cur = SECTIONS.find((s) => s.id === section)!;
  const feedCount = feeds.data?.length ?? 0;

  const subs: Record<string, string> = {
    general: t("settings.sub.general"),
    appearance: t("settings.sub.appearance"),
    reading: t("settings.sub.reading"),
    subscriptions: t("settings.sub.subscriptions", { count: feedCount }),
    shortcuts: t("settings.sub.shortcuts"),
    notifications: t("settings.sub.notifications"),
    ai: t("settings.sub.ai"),
    advanced: t("settings.sub.advanced"),
    about: t("settings.sub.about"),
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-window"
        ref={windowRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-sidebar">
          <div className="settings-sidebar-title">
            {t("settings.title")}
            <span className="badge">{modCombo(",")}</span>
          </div>
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              className={`settings-nav-item ${section === s.id ? "active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              <span className="nav-ico">
                <Icon name={s.icon} size={15} />
              </span>
              {t(s.labelKey)}
            </div>
          ))}
          <div className="settings-nav-spacer" />
          <div className="settings-version">
            Papr{version && ` ${version}`}
          </div>
        </div>

        <div className="settings-content">
          <div className="settings-header">
            <h2>{t(cur.labelKey)}</h2>
            <span className="sub">{subs[section]}</span>
          </div>
          <button
            className="settings-close"
            onClick={onClose}
            title={t("settings.closeTitle")}
          >
            <Icon name="x" size={15} />
          </button>

          <div className="settings-scroll">
            {section === "general" && <GeneralSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "reading" && <ReadingSection />}
            {section === "subscriptions" && (
              <SubscriptionsSection
                feeds={feeds.data ?? []}
                onToast={onToast}
                onAddFeed={onAddFeed}
              />
            )}
            {section === "shortcuts" && <ShortcutsSection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "ai" && <AiSettingsGroup onToast={onToast} />}
            {section === "advanced" && <AdvancedSection onToast={onToast} />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── row helpers ─────────────────────────────────────────── */
function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  // Name the row's control with the row label so screen readers don't just
  // announce a bare "checkbox" / "slider" / "combobox". The control
  // components forward the injected aria-label to their element.
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ "aria-label"?: string }>, {
        "aria-label": label,
      })
    : children;
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <input
      type="checkbox"
      className="s-toggle"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  "aria-label"?: string;
}) {
  return (
    <select
      className="s-select"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  "aria-label"?: string;
}) {
  return (
    <div className="s-seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "on" : ""}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The keys that actually move an `<input type="range">`. `onKeyUp` fires for
 *  every key release while the slider is focused — Tab (which merely lands or
 *  leaves focus), Shift, the modifier keys — so committing on a bare keyup
 *  would run `onCommit` for a key that never changed the value. For the
 *  network-timeout slider that side effect is a full HTTP-client rebuild, so a
 *  user simply Tab-navigating through Settings would trigger one. Restrict the
 *  commit to releases of a value-changing key. */
const SLIDER_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown",
]);

function Slider({
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
  onCommit,
  "aria-label": ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Fires on every drag tick — for cheap, live updates (e.g. reader preview). */
  onChange?: (v: number) => void;
  /** Fires once the drag/keypress settles — for costly side effects (a backend
   *  write, an HTTP-client rebuild) that must not run ~20× across one drag. */
  onCommit?: (v: number) => void;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Follow external changes (async settings load, reset) when not mid-drag.
  useEffect(() => setDraft(value), [value]);
  return (
    <>
      <input
        type="range"
        className="s-slider"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-label={ariaLabel}
        aria-valuetext={`${draft}${unit}`}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraft(v);
          onChange?.(v);
        }}
        onPointerUp={(e) =>
          onCommit?.(Number((e.target as HTMLInputElement).value))
        }
        onKeyUp={(e) => {
          // Only a key that can move the slider commits — a bare keyup from
          // Tab / Shift / a modifier never changed the value.
          if (SLIDER_KEYS.has(e.key)) {
            onCommit?.(Number((e.target as HTMLInputElement).value));
          }
        }}
      />
      <span className="s-value">
        {draft}
        {unit}
      </span>
    </>
  );
}

/** A toggle row backed by a persisted backend setting ("1" / "0"). */
function SettingFlag({
  settingKey,
  label,
  desc,
  fallback = false,
  onChanged,
}: {
  settingKey: string;
  label: string;
  desc?: string;
  fallback?: boolean;
  onChanged?: (v: boolean) => void;
}) {
  const [val, setVal] = useState(fallback);
  useEffect(() => {
    api
      .getSetting(settingKey)
      .then((v) => {
        if (v != null && v !== "") setVal(v === "1");
      })
      .catch(() => {});
  }, [settingKey]);
  const change = (v: boolean) => {
    setVal(v);
    api.setSetting(settingKey, v ? "1" : "0").catch(() => {});
    onChanged?.(v);
  };
  return (
    <Row label={label} desc={desc}>
      <Toggle checked={val} onChange={change} />
    </Row>
  );
}

/** Bytes → human-readable size. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Open-at-login toggle, backed by the OS via the autostart plugin. */
function LaunchAtLogin() {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  useEffect(() => {
    isEnabled().then(setOn).catch(() => {});
  }, []);
  const change = async (v: boolean) => {
    try {
      if (v) await enable();
      else await disable();
      setOn(v);
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <Row
      label={t("settings.general.launchAtLogin")}
      desc={t("settings.general.launchAtLoginDesc")}
    >
      <Toggle checked={on} onChange={change} />
    </Row>
  );
}

/** Editor for a user-editable prompt template (Settings → AI). The field shows
 *  the *effective* prompt — the user's own template when one is stored, else
 *  the built-in one fetched from the backend — so it doubles as a read-out of
 *  what is currently sent to the model. Text identical to the built-in prompt
 *  is stored as "" (unset), which keeps the default tracking future app
 *  versions and makes "restore default" just "show the default, then commit". */
function PromptEditor({
  settingKey,
  loadBuiltin,
  label,
  desc,
  resetLabel,
  onToast,
}: {
  settingKey: string;
  loadBuiltin: () => Promise<string>;
  label: string;
  desc: string;
  resetLabel: string;
  onToast: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [builtin, setBuiltin] = useState("");
  // The stored template ("" = unset), so a blur that changed nothing writes
  // nothing.
  const saved = useRef("");

  useEffect(() => {
    Promise.all([api.getSetting(settingKey), loadBuiltin()])
      .then(([stored, dflt]) => {
        setBuiltin(dflt);
        saved.current = stored ?? "";
        setText(saved.current.trim() ? saved.current : dflt);
      })
      .catch(() => {});
  }, [settingKey, loadBuiltin]);

  const commit = (value: string) => {
    const stored = value.trim() === builtin.trim() ? "" : value.trim();
    if (stored === saved.current) return;
    saved.current = stored;
    api
      .setSetting(settingKey, stored)
      .then(() => onToast(t("settings.ai.aiSaved", { label })))
      .catch((e) => reportError(e));
  };

  return (
    <div className="settings-prompt">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-desc">{desc}</div>
      </div>
      <textarea
        className="s-textarea"
        {...NO_AUTOCORRECT}
        rows={9}
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
      />
      <div className="settings-prompt-foot">
        <button
          className="s-btn"
          onClick={() => {
            setText(builtin);
            commit(builtin);
          }}
          disabled={text.trim() === builtin.trim()}
        >
          {resetLabel}
        </button>
      </div>
    </div>
  );
}

/** The selection shown before the stored value loads — mirrors
 *  `summary::DEFAULT_PRESET` on the backend. */
const DEFAULT_SUMMARY_PRESET = "general";

/** Display names for the built-in summary presets, keyed by the preset id the
 *  backend ships. The backend owns the templates; the frontend owns the
 *  localized labels. An id missing here falls back to the raw id, so a preset
 *  added by a newer backend still lists. */
const SUMMARY_PRESET_LABELS: Record<string, string> = {
  general: "settings.ai.presetGeneral",
  brief: "settings.ai.presetBrief",
  deep: "settings.ai.presetDeep",
};

/** The AI-summary prompt: a picker over the built-in presets (shown read-only)
 *  plus a Custom option whose text is editable. A custom template with nothing
 *  stored shows — and the backend applies — the "general" preset's text, so
 *  switching to Custom without editing behaves exactly like General. */
function SummaryPromptEditor({ onToast }: { onToast: (m: string) => void }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<{ id: string; template: string }[]>(
    [],
  );
  const [preset, setPreset] = useState(DEFAULT_SUMMARY_PRESET);
  const [custom, setCustom] = useState("");
  // The stored custom template ("" = unset), so a blur that changed nothing
  // writes nothing.
  const savedCustom = useRef("");

  useEffect(() => {
    Promise.all([
      api.getSetting("summary_preset"),
      api.getSetting("summary_prompt"),
      api.summaryPresets(),
    ])
      .then(([p, c, list]) => {
        setPresets(list);
        setPreset(p && p.trim() ? p : DEFAULT_SUMMARY_PRESET);
        savedCustom.current = c ?? "";
        setCustom(savedCustom.current);
      })
      .catch(() => {});
  }, []);

  const general = presets.find((p) => p.id === DEFAULT_SUMMARY_PRESET)?.template ?? "";
  const isCustom = preset === "custom";
  // What the field shows: the custom template when Custom is selected, else the
  // selected preset's. A blank custom template shows General's text — the same
  // fallback the backend applies.
  const shown = isCustom
    ? custom.trim() || general
    : presets.find((p) => p.id === preset)?.template ?? general;

  // Text identical to the General preset is stored as "" (unset), which keeps
  // the seed tracking future preset changes and makes "restore default" just
  // "show General, then commit".
  const commit = (value: string) => {
    const stored = value.trim() === general.trim() ? "" : value.trim();
    if (stored === savedCustom.current) return;
    savedCustom.current = stored;
    api
      .setSetting("summary_prompt", stored)
      .then(() =>
        onToast(t("settings.ai.aiSaved", { label: t("settings.ai.summaryPrompt") })),
      )
      .catch((e) => reportError(e));
  };

  return (
    <div className="settings-prompt">
      <div className="settings-row-text">
        <div className="settings-row-label">{t("settings.ai.summaryPrompt")}</div>
        <div className="settings-row-desc">
          {t("settings.ai.summaryPromptDesc")}
        </div>
      </div>
      <div className="settings-prompt-controls">
        <Select
          value={preset}
          options={[
            ...presets.map((p) => ({
              value: p.id,
              label: t(SUMMARY_PRESET_LABELS[p.id] ?? p.id),
            })),
            { value: "custom", label: t("settings.ai.presetCustom") },
          ]}
          aria-label={t("settings.ai.summaryPrompt")}
          onChange={(id) => {
            setPreset(id);
            api.setSetting("summary_preset", id).catch((e) => reportError(e));
          }}
        />
        {isCustom && (
          <button
            className="s-btn"
            onClick={() => {
              setCustom(general);
              commit(general);
            }}
            disabled={custom.trim() === general.trim()}
          >
            {t("settings.ai.summaryPromptReset")}
          </button>
        )}
      </div>
      <textarea
        className="s-textarea"
        {...NO_AUTOCORRECT}
        rows={9}
        readOnly={!isCustom}
        value={shown}
        aria-label={t("settings.ai.summaryPrompt")}
        onChange={(e) => setCustom(e.target.value)}
        onBlur={() => isCustom && commit(custom)}
      />
      {!isCustom && (
        <div className="settings-prompt-hint">
          {t("settings.ai.presetReadOnly")}
        </div>
      )}
    </div>
  );
}

/* ── general ─────────────────────────────────────────────── */
// Auto-refresh "off" is stored as a year-long interval — the only lever the
// backend scheduler exposes (it reads `refresh_interval_min`, minimum 5).
const OFF_INTERVAL = 525600;

// A persisted numeric setting, coerced into the range its `<Slider>` accepts.
// Settings live in the backend DB and are normally written numeric, but a
// stale value from an older build with different slider limits — or a corrupt
// non-numeric value — would otherwise flow straight into a `<Slider>`: an
// out-of-range value pins the thumb at the limit while the readout shows a
// contradicting number, and a NaN renders the value as a literal "NaN". This
// mirrors `store.ts`'s `ls.num`, which validates the localStorage-backed
// reader sliders for exactly the same reason.
function clampSetting(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function GeneralSection() {
  const { t } = useTranslation();
  const prefs = useUi((s) => s.prefs);
  const setPref = useUi((s) => s.setPref);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshMins, setRefreshMins] = useState(30);

  useEffect(() => {
    api
      .getSetting("refresh_interval_min")
      .then((v) => {
        const n = v ? Number(v) : 30;
        // A finite interval at/above the "off" sentinel means auto-refresh is
        // disabled; anything else is a live interval clamped to the slider's
        // 5–120 range (a stale larger value would otherwise show e.g. "150
        // minutes" with the thumb stuck at 120, and a NaN would read "NaN").
        if (Number.isFinite(n) && n >= 100000) setAutoRefresh(false);
        else {
          setAutoRefresh(true);
          setRefreshMins(clampSetting(v ?? null, 30, 5, 120));
        }
      })
      .catch(() => {});
  }, []);

  const writeInterval = (auto: boolean, mins: number) => {
    api
      .setSetting("refresh_interval_min", auto ? String(mins) : String(OFF_INTERVAL))
      .catch(() => {});
  };

  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.general.refresh")}</h3>
        <Row
          label={t("settings.general.autoRefresh")}
          desc={t("settings.general.autoRefreshDesc")}
        >
          <Toggle
            checked={autoRefresh}
            onChange={(v) => {
              setAutoRefresh(v);
              writeInterval(v, refreshMins);
            }}
          />
        </Row>
        {autoRefresh && (
          <Row
            label={t("settings.general.refreshInterval")}
            desc={t("settings.general.refreshIntervalDesc")}
          >
            <Slider
              value={refreshMins}
              min={5}
              max={120}
              step={5}
              unit={t("settings.general.minutesUnit")}
              onChange={setRefreshMins}
              onCommit={(m) => writeInterval(true, m)}
            />
          </Row>
        )}
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.general.readBehavior")}</h3>
        <Row label={t("settings.general.markReadOnOpen")}>
          <Toggle
            checked={prefs.markReadOnOpen}
            onChange={(v) => setPref({ markReadOnOpen: v })}
          />
        </Row>
        <Row
          label={t("settings.general.markReadOnScroll")}
          desc={t("settings.general.markReadOnScrollDesc")}
        >
          <Toggle
            checked={prefs.markReadOnScroll}
            onChange={(v) => setPref({ markReadOnScroll: v })}
          />
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.general.startup")}</h3>
        <LaunchAtLogin />
        <Row
          label={t("settings.general.startupView")}
          desc={t("settings.general.startupViewDesc")}
        >
          <Select
            value={prefs.startupView}
            options={[
              { value: "all", label: t("settings.general.startupAll") },
              { value: "unread", label: t("smart.unread") },
              { value: "starred", label: t("smart.starred") },
              { value: "last", label: t("settings.general.startupLast") },
            ]}
            onChange={(v) => setPref({ startupView: v })}
          />
        </Row>
        <Row label={t("settings.general.hideReadOnStartup")}>
          <Toggle
            checked={prefs.hideReadOnStartup}
            onChange={(v) => setPref({ hideReadOnStartup: v })}
          />
        </Row>
      </div>
    </>
  );
}

/* ── appearance ──────────────────────────────────────────── */
function AppearanceSection() {
  const { t, i18n } = useTranslation();
  const palette = useUi((s) => s.palette);
  const setPalette = useUi((s) => s.setPalette);
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const density = useUi((s) => s.density);
  const setDensity = useUi((s) => s.setDensity);
  const viewMode = useUi((s) => s.viewMode);
  const setViewMode = useUi((s) => s.setViewMode);
  const prefs = useUi((s) => s.prefs);
  const setPref = useUi((s) => s.setPref);

  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.appearance.language")}</h3>
        <Row
          label={t("settings.appearance.uiLanguage")}
          desc={t("settings.appearance.languageDesc")}
        >
          <Select
            value={i18n.language}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            onChange={(v) => setLanguage(v as Language)}
          />
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.appearance.theme")}</h3>
        <Row
          label={t("settings.appearance.palette")}
          desc={t("settings.appearance.paletteDesc")}
        >
          <Segmented
            value={palette}
            options={[
              { value: "paper", label: t("settings.appearance.palettePaper") },
              { value: "frost", label: t("settings.appearance.paletteFrost") },
              { value: "contrast", label: t("settings.appearance.paletteContrast") },
            ]}
            onChange={setPalette}
          />
        </Row>
        <Row
          label={t("settings.appearance.appearance")}
          desc={t("settings.appearance.appearanceDesc")}
        >
          <Segmented
            value={mode}
            options={[
              { value: "light", label: t("settings.appearance.light") },
              { value: "dark", label: t("settings.appearance.dark") },
              { value: "system", label: t("settings.appearance.system") },
            ]}
            onChange={setMode}
          />
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.appearance.layout")}</h3>
        <Row
          label={t("settings.appearance.density")}
          desc={t("settings.appearance.densityDesc")}
        >
          <Segmented
            value={density}
            options={[
              { value: "compact", label: t("settings.appearance.densityCompact") },
              { value: "cozy", label: t("settings.appearance.densityCozy") },
              { value: "spacious", label: t("settings.appearance.densitySpacious") },
            ]}
            onChange={setDensity}
          />
        </Row>
        <Row label={t("settings.appearance.listStyle")}>
          <Segmented
            value={viewMode}
            options={[
              { value: "list", label: t("settings.appearance.listStyleList") },
              { value: "small-image", label: t("settings.appearance.listStyleSmallImage") },
              { value: "card", label: t("settings.appearance.listStyleCard") },
            ]}
            onChange={setViewMode}
          />
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.appearance.details")}</h3>
        <Row label={t("settings.appearance.sidebarCounts")}>
          <Toggle
            checked={prefs.showSidebarCounts}
            onChange={(v) => setPref({ showSidebarCounts: v })}
          />
        </Row>
        <Row
          label={t("settings.appearance.cardThumbs")}
          desc={t("settings.appearance.cardThumbsDesc")}
        >
          <Toggle
            checked={prefs.showCardThumbs}
            onChange={(v) => setPref({ showCardThumbs: v })}
          />
        </Row>
        <Row
          label={t("settings.appearance.reduceMotion")}
          desc={t("settings.appearance.reduceMotionDesc")}
        >
          <Toggle
            checked={prefs.reduceMotion}
            onChange={(v) => setPref({ reduceMotion: v })}
          />
        </Row>
      </div>
    </>
  );
}

/* ── reading ─────────────────────────────────────────────── */
function ReadingSection() {
  const { t } = useTranslation();
  const readerFont = useUi((s) => s.readerFont);
  const setReaderFont = useUi((s) => s.setReaderFont);
  const readerSize = useUi((s) => s.readerSize);
  const readerLeading = useUi((s) => s.readerLeading);
  const readerWidth = useUi((s) => s.readerWidth);
  const setReader = useUi((s) => s.setReader);
  const prefs = useUi((s) => s.prefs);
  const setPref = useUi((s) => s.setPref);
  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.reading.font")}</h3>
        <Row
          label={t("settings.reading.bodyFont")}
          desc={t("settings.reading.bodyFontDesc")}
        >
          <FontPicker value={readerFont} onChange={setReaderFont} />
        </Row>
        <Row label={t("settings.reading.fontSize")}>
          <Slider
            value={readerSize}
            min={READER_BOUNDS.size.min}
            max={READER_BOUNDS.size.max}
            unit="px"
            onChange={(v) => setReader({ readerSize: v })}
          />
        </Row>
        <Row label={t("settings.reading.lineHeight")}>
          <Slider
            value={readerLeading}
            min={READER_BOUNDS.leading.min}
            max={READER_BOUNDS.leading.max}
            step={5}
            unit="%"
            onChange={(v) => setReader({ readerLeading: v })}
          />
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.reading.layout")}</h3>
        <Row label={t("settings.reading.maxWidth")}>
          <Slider
            value={readerWidth}
            min={READER_BOUNDS.width.min}
            max={READER_BOUNDS.width.max}
            step={20}
            unit="px"
            onChange={(v) => setReader({ readerWidth: v })}
          />
        </Row>
        <Row
          label={t("settings.reading.readingTime")}
          desc={t("settings.reading.readingTimeDesc")}
        >
          <Toggle
            checked={prefs.showReadingTime}
            onChange={(v) => setPref({ showReadingTime: v })}
          />
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.reading.openModeTitle")}</h3>
        <Row
          label={t("settings.reading.defaultOpenMode")}
          desc={t("settings.reading.defaultOpenModeDesc")}
        >
          <Select
            value={prefs.defaultOpenMode}
            options={[
              { value: "reader", label: t("settings.subscriptions.openReader") },
              {
                value: "extracted",
                label: t("settings.subscriptions.openExtracted"),
              },
              { value: "web", label: t("settings.subscriptions.openWeb") },
            ]}
            onChange={(v) => setPref({ defaultOpenMode: v as OpenMode })}
          />
        </Row>
      </div>
    </>
  );
}

/* ── subscriptions ───────────────────────────────────────── */
function SubscriptionsSection({
  feeds,
  onToast,
  onAddFeed,
}: {
  feeds: Feed[];
  onToast: (m: string) => void;
  onAddFeed: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const actions = useArticleActions();
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const filtered = feeds.filter(
    (f) => !search || f.title.toLowerCase().includes(search.toLowerCase()),
  );

  // Per-feed refresh interval. "default" ⇒ null (follow the global setting),
  // "off" ⇒ the 525600-minute sentinel, otherwise the literal minute count.
  const REFRESH_OFF = 525600;
  const intervalOptions = [
    { value: "default", label: t("settings.subscriptions.refreshDefault") },
    { value: "15", label: t("settings.subscriptions.refresh15m") },
    { value: "30", label: t("settings.subscriptions.refresh30m") },
    { value: "60", label: t("settings.subscriptions.refresh1h") },
    { value: "360", label: t("settings.subscriptions.refresh6h") },
    { value: "720", label: t("settings.subscriptions.refresh12h") },
    { value: "1440", label: t("settings.subscriptions.refresh1d") },
    { value: "off", label: t("settings.subscriptions.refreshOff") },
  ];
  const intervalValue = (m: number | null) =>
    m == null ? "default" : m >= REFRESH_OFF ? "off" : String(m);
  const updateInterval = (f: Feed, v: string) => {
    const minutes = v === "default" ? null : v === "off" ? REFRESH_OFF : Number(v);
    api
      .setFeedRefreshInterval(f.id, minutes)
      .then(() => qc.invalidateQueries({ queryKey: ["feeds"] }))
      .catch((e) => reportError(e));
  };
  // Per-feed auto-translate: opening an article from a feed with this on
  // translates it into the configured target language straight away.
  const updateAutoTranslate = (f: Feed, enabled: boolean) => {
    api
      .setFeedAutoTranslate(f.id, enabled)
      .then(() => qc.invalidateQueries({ queryKey: ["feeds"] }))
      .catch((e) => reportError(e));
  };
  // Per-feed open mode (issue #110): how the feed's articles open in the
  // reader pane. "default" ⇒ null (reader view, honouring the global
  // auto-extract preference).
  const openModeOptions = [
    { value: "default", label: t("settings.subscriptions.openDefault") },
    { value: "reader", label: t("settings.subscriptions.openReader") },
    { value: "extracted", label: t("settings.subscriptions.openExtracted") },
    { value: "web", label: t("settings.subscriptions.openWeb") },
  ];
  const updateOpenMode = (f: Feed, v: string) => {
    const mode = v === "default" ? null : (v as "reader" | "extracted" | "web");
    api
      .setFeedOpenMode(f.id, mode)
      .then(() => qc.invalidateQueries({ queryKey: ["feeds"] }))
      .catch((e) => reportError(e));
  };

  const exportOpml = async () => {
    try {
      const xml = await api.exportOpml();
      downloadFile(xml, "subscriptions.opml", "text/xml");
      onToast(t("settings.subscriptions.opmlExported"));
    } catch (e) {
      reportError(e);
    }
  };

  const importOpml = async (file: File) => {
    try {
      const n = await api.importOpml(await file.text());
      await qc.invalidateQueries();
      onToast(t("settings.subscriptions.opmlImported", { count: n }));
    } catch (e) {
      reportError(e);
    }
  };

  const unsubscribe = (f: Feed) =>
    api
      .deleteFeed(f.id)
      .then(() => {
        // Unsubscribing touches only article-bearing caches — unlike OPML
        // import, it needs no full invalidation.
        actions.refreshAfterBulk();
        onToast(t("settings.subscriptions.unsubscribed", { title: f.title }));
      })
      .catch((e) => reportError(e));

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".opml,.xml"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importOpml(f);
          e.target.value = "";
        }}
      />
      <div className="settings-group" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 7,
              border: "1px solid var(--hair-strong)",
              background: "var(--panel)",
            }}
          >
            <Icon name="search" size={13} color="var(--muted)" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("settings.subscriptions.searchPlaceholder")}
              {...NO_AUTOCORRECT}
              style={{
                flex: 1,
                border: 0,
                outline: 0,
                background: "transparent",
                fontFamily: "inherit",
                fontSize: 12.5,
                color: "var(--ink)",
              }}
            />
          </div>
          <button className="s-btn" onClick={() => fileRef.current?.click()}>
            <Icon name="arrow-down" size={12} /> {t("settings.subscriptions.importOpml")}
          </button>
          <button className="s-btn" onClick={exportOpml}>
            <Icon name="arrow-up" size={12} /> {t("settings.subscriptions.export")}
          </button>
          <button className="s-btn primary" onClick={onAddFeed}>
            <Icon name="plus" size={12} /> {t("common.add")}
          </button>
        </div>
      </div>
      <RsshubInstanceGroup />
      <div className="settings-group">
        <h3 className="settings-group-title">
          {t("settings.subscriptions.feedsCount", { count: filtered.length })}
        </h3>
        <div>
          {filtered.map((f) => (
            <div key={f.id} className="s-feed-row">
              <FeedAvatar
                title={f.title}
                faviconUrl={f.faviconUrl}
                seed={f.id}
                style={{ width: 22, height: 22, borderRadius: 5 }}
              />
              <span className="name">{f.title}</span>
              <span className="url">{feedHost(f)}</span>
              <div className="actions">
                <label
                  className="s-feed-autotr"
                  title={t("settings.subscriptions.autoTranslateDesc")}
                >
                  <Icon name="globe" size={13} color="var(--muted)" />
                  <Toggle
                    checked={f.autoTranslate}
                    onChange={(v) => updateAutoTranslate(f, v)}
                    aria-label={t("settings.subscriptions.autoTranslate")}
                  />
                </label>
                <Select
                  value={f.openMode ?? "default"}
                  options={openModeOptions}
                  onChange={(v) => updateOpenMode(f, v)}
                  aria-label={t("settings.subscriptions.openMode")}
                />
                <Select
                  value={intervalValue(f.refreshIntervalMin)}
                  options={intervalOptions}
                  onChange={(v) => updateInterval(f, v)}
                  aria-label={t("settings.subscriptions.refreshInterval")}
                />
                <button
                  className="icon-btn"
                  title={t("settings.subscriptions.unsubscribe")}
                  onClick={() => unsubscribe(f)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div
              style={{ padding: "16px 4px", fontSize: 13, color: "var(--muted)" }}
            >
              {t("settings.subscriptions.noMatch")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * RSSHub instance for expanding `rsshub://route` short links. Blank uses the
 * public rsshub.app; self-hosters point it at their own instance. Persisted to
 * the `rsshub_instance` setting that `add_feed` reads server-side.
 */
function RsshubInstanceGroup() {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  useEffect(() => {
    api
      .getSetting("rsshub_instance")
      .then((v) => setValue(v ?? ""))
      .catch(() => {});
  }, []);

  const commit = () => {
    api.setSetting("rsshub_instance", value.trim()).catch(() => {});
  };

  return (
    <div className="settings-group" style={{ marginBottom: 18 }}>
      <h3 className="settings-group-title">{t("settings.subscriptions.rsshubTitle")}</h3>
      <Row
        label={t("settings.subscriptions.rsshubInstance")}
        desc={t("settings.subscriptions.rsshubInstanceDesc")}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="https://rsshub.app"
          {...NO_AUTOCORRECT}
          style={{
            width: 220,
            padding: "5px 9px",
            borderRadius: 7,
            border: "1px solid var(--hair-strong)",
            background: "var(--panel)",
            fontFamily: "inherit",
            fontSize: 12.5,
            color: "var(--ink)",
            outline: 0,
          }}
        />
      </Row>
    </div>
  );
}

/* ── shortcuts ───────────────────────────────────────────── */
function ShortcutsSection() {
  const { t } = useTranslation();
  const groups = [
    {
      title: t("settings.shortcuts.navigation"),
      items: [
        { desc: t("settings.shortcuts.nextArticle"), keys: ["J"] },
        { desc: t("settings.shortcuts.prevArticle"), keys: ["K"] },
        { desc: t("settings.shortcuts.openInBrowser"), keys: ["O"] },
        { desc: t("settings.shortcuts.toggleRead"), keys: ["U"] },
        { desc: t("settings.shortcuts.exitFocus"), keys: ["Esc"] },
      ],
    },
    {
      title: t("settings.shortcuts.actions"),
      items: [
        { desc: t("settings.shortcuts.star"), keys: ["S"] },
        { desc: t("settings.shortcuts.readLater"), keys: ["B"] },
        { desc: t("settings.shortcuts.aiSummary"), keys: ["I"] },
        { desc: t("settings.shortcuts.markAllRead"), keys: ["⇧", "A"] },
      ],
    },
    {
      title: t("settings.shortcuts.view"),
      items: [
        { desc: t("settings.shortcuts.focusReading"), keys: ["F"] },
        { desc: t("settings.shortcuts.hideRead"), keys: ["V"] },
        { desc: t("settings.shortcuts.toggleTheme"), keys: ["⇧", "D"] },
      ],
    },
    {
      title: t("settings.shortcuts.global"),
      items: [
        { desc: t("settings.shortcuts.commandPalette"), keys: [modKey, "K"] },
        { desc: t("settings.shortcuts.refreshAll"), keys: [modKey, "R"] },
        { desc: t("settings.shortcuts.addFeed"), keys: ["A"] },
        { desc: t("settings.shortcuts.openSettings"), keys: [modKey, ","] },
      ],
    },
  ];
  return (
    <>
      {groups.map((g) => (
        <div className="settings-group" key={g.title}>
          <h3 className="settings-group-title">{g.title}</h3>
          <div className="s-shortcuts">
            {g.items.map((it, i) => (
              <div className="s-shortcut" key={i}>
                <span className="desc">{it.desc}</span>
                <span className="keys">
                  {it.keys.map((k, j) => (
                    <span className="s-key" key={j}>
                      {k}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ── notifications ───────────────────────────────────────── */
function NotificationsSection() {
  const { t } = useTranslation();
  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.notifications.system")}</h3>
        <SettingFlag
          settingKey="notify_enabled"
          fallback
          label={t("settings.notifications.allow")}
          desc={t("settings.notifications.allowDesc")}
        />
        <SettingFlag
          settingKey="notify_badge"
          fallback
          label={t("settings.notifications.badge")}
          desc={t("settings.notifications.badgeDesc")}
        />
        <SettingFlag
          settingKey="notify_sound"
          label={t("settings.notifications.sound")}
          desc={t("settings.notifications.soundDesc")}
        />
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.notifications.dnd")}</h3>
        <SettingFlag
          settingKey="notify_dnd_night"
          label={t("settings.notifications.dndNight")}
          desc={t("settings.notifications.dndNightDesc")}
        />
      </div>
    </>
  );
}

/* ── advanced ────────────────────────────────────────────── */
function AdvancedSection({ onToast }: { onToast: (m: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <StorageGroup onToast={onToast} />
      <NetworkGroup onToast={onToast} />
      <div className="settings-group">
        <h3 className="settings-group-title">{t("settings.advanced.experimental")}</h3>
        <SettingFlag
          settingKey="dedup_enabled"
          label={t("settings.advanced.dedup")}
          desc={t("settings.advanced.dedupDesc")}
        />
      </div>
      <DangerZone onToast={onToast} />
    </>
  );
}

/** Storage panel — real database size, retention cleanup, vacuum. */
function StorageGroup({ onToast }: { onToast: (m: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stats = useQuery({
    queryKey: ["storage-stats"],
    queryFn: api.storageStats,
  });
  const [retention, setRetention] = useState("forever");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getSetting("retention_days")
      .then((v) => {
        if (v) setRetention(v);
      })
      .catch(() => {});
  }, []);

  const cleanup = async () => {
    if (retention === "forever") {
      onToast(t("settings.advanced.cleanupForever"));
      return;
    }
    setBusy(true);
    try {
      const n = await api.cleanupArticles(Number(retention));
      await qc.invalidateQueries();
      onToast(
        n > 0
          ? t("settings.advanced.cleanupDone", { count: n })
          : t("settings.advanced.cleanupNone"),
      );
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const vacuum = async () => {
    setBusy(true);
    try {
      await api.vacuumDb();
      await qc.invalidateQueries({ queryKey: ["storage-stats"] });
      onToast(t("settings.advanced.vacuumDone"));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const s = stats.data;
  return (
    <div className="settings-group">
      <h3 className="settings-group-title">{t("settings.advanced.storage")}</h3>
      <Row
        label={t("settings.advanced.dbUsage")}
        desc={
          s
            ? t("settings.advanced.dbUsageDesc", {
                articles: s.articleCount,
                feeds: s.feedCount,
              })
            : t("settings.advanced.calculating")
        }
      >
        <span className="s-value">{s ? formatBytes(s.dbBytes) : "—"}</span>
      </Row>
      <Row
        label={t("settings.advanced.retention")}
        desc={t("settings.advanced.retentionDesc")}
      >
        <Select
          value={retention}
          options={[
            { value: "30", label: t("settings.advanced.retention30") },
            { value: "90", label: t("settings.advanced.retention90") },
            { value: "180", label: t("settings.advanced.retention180") },
            { value: "forever", label: t("settings.advanced.retentionForever") },
          ]}
          onChange={(v) => {
            setRetention(v);
            api.setSetting("retention_days", v).catch(() => {});
          }}
        />
      </Row>
      <Row
        label={t("settings.advanced.cleanupNow")}
        desc={t("settings.advanced.cleanupNowDesc")}
      >
        <button className="s-btn" onClick={cleanup} disabled={busy}>
          {t("settings.advanced.cleanup")}
        </button>
      </Row>
      <Row
        label={t("settings.advanced.vacuum")}
        desc={t("settings.advanced.vacuumDesc")}
      >
        <button className="s-btn" onClick={vacuum} disabled={busy}>
          {t("settings.advanced.compress")}
        </button>
      </Row>
    </div>
  );
}

/** Network panel — proxy, fetch concurrency, request timeout. */
function NetworkGroup({ onToast }: { onToast: (m: string) => void }) {
  const { t } = useTranslation();
  const [proxy, setProxy] = useState("system");
  const [customProxy, setCustomProxy] = useState("");
  const [concurrency, setConcurrency] = useState(6);
  const [timeoutSec, setTimeoutSec] = useState(30);

  useEffect(() => {
    Promise.all([
      api.getSetting("net_proxy"),
      api.getSetting("net_concurrency"),
      api.getSetting("net_timeout_sec"),
    ])
      .then(([p, c, t]) => {
        if (p === "system" || p === "none") setProxy(p);
        else if (p) {
          setProxy("custom");
          setCustomProxy(p);
        }
        // Clamp to each slider's range (concurrency 1–16, timeout 5–120) so a
        // stale or corrupt stored value can't show a NaN / out-of-range readout.
        if (c) setConcurrency(clampSetting(c, 6, 1, 16));
        if (t) setTimeoutSec(clampSetting(t, 30, 5, 120));
      })
      .catch(() => {});
  }, []);

  const saveProxy = (mode: string, custom: string) => {
    const value = mode === "custom" ? custom : mode;
    api
      .setSetting("net_proxy", value)
      .then(() => api.applyNetworkSettings())
      .then(() => onToast(t("settings.advanced.proxyApplied")))
      .catch((e) => reportError(e));
  };

  return (
    <div className="settings-group">
      <h3 className="settings-group-title">{t("settings.advanced.network")}</h3>
      <Row label={t("settings.advanced.proxy")}>
        <Select
          value={proxy}
          options={[
            { value: "system", label: t("settings.advanced.proxySystem") },
            { value: "none", label: t("settings.advanced.proxyNone") },
            { value: "custom", label: t("settings.advanced.proxyCustom") },
          ]}
          onChange={(v) => {
            setProxy(v);
            if (v !== "custom") saveProxy(v, "");
          }}
        />
      </Row>
      {proxy === "custom" && (
        <Row
          label={t("settings.advanced.proxyAddress")}
          desc={t("settings.advanced.proxyAddressDesc")}
        >
          <input
            className="s-text-input"
            {...NO_AUTOCORRECT}
            value={customProxy}
            placeholder="http://host:port"
            onChange={(e) => setCustomProxy(e.target.value)}
            onBlur={() => saveProxy("custom", customProxy)}
          />
        </Row>
      )}
      <Row
        label={t("settings.advanced.concurrency")}
        desc={t("settings.advanced.concurrencyDesc")}
      >
        <Slider
          value={concurrency}
          min={1}
          max={16}
          onChange={setConcurrency}
          onCommit={(v) =>
            api.setSetting("net_concurrency", String(v)).catch(() => {})
          }
        />
      </Row>
      <Row label={t("settings.advanced.timeout")}>
        <Slider
          value={timeoutSec}
          min={5}
          max={120}
          step={5}
          unit={t("settings.advanced.secondsUnit")}
          onChange={setTimeoutSec}
          onCommit={(v) =>
            api
              .setSetting("net_timeout_sec", String(v))
              .then(() => api.applyNetworkSettings())
              .catch(() => {})
          }
        />
      </Row>
    </div>
  );
}

/** Danger zone — reset settings, wipe all local data. Each action is gated by
 *  a themed ConfirmDialog rather than the native, unstyled window.confirm. */
function DangerZone({ onToast }: { onToast: (m: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<null | "reset" | "clear">(null);

  const doReset = async () => {
    try {
      await api.resetSettings();
      for (const k of Object.keys(localStorage)) {
        if (
          k.startsWith("pref.") ||
          [
            // "accent" / "darkShade" are intentionally still cleared: they
            // remove any value persisted by older builds that exposed an
            // accent picker / dark-shade picker.
            // "theme" is the pre-6-theme key; still cleared so a reset wipes it
            // for migrated installs. "palette"/"mode" are the current keys.
            "palette", "mode", "theme", "accent", "darkShade", "density", "viewMode", "readerFont",
            "useSerif", "readerSize", "readerLeading", "readerWidth",
            "collapsedFolders",
          ].includes(k)
        ) {
          localStorage.removeItem(k);
        }
      }
      onToast(t("settings.advanced.resetDone"));
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      reportError(e);
    }
  };
  const doClear = async () => {
    try {
      await api.clearAllData();
      await qc.invalidateQueries();
      onToast(t("settings.advanced.clearDone"));
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="settings-group">
      <h3 className="settings-group-title">{t("settings.advanced.dangerZone")}</h3>
      <Row
        label={t("settings.advanced.resetSettings")}
        desc={t("settings.advanced.resetSettingsDesc")}
      >
        <button className="s-btn" onClick={() => setConfirming("reset")}>
          {t("settings.advanced.reset")}
        </button>
      </Row>
      <Row
        label={t("settings.advanced.clearData")}
        desc={t("settings.advanced.clearDataDesc")}
      >
        <button className="s-btn danger" onClick={() => setConfirming("clear")}>
          {t("settings.advanced.clear")}
        </button>
      </Row>
      {confirming === "reset" && (
        <ConfirmDialog
          title={t("settings.advanced.resetSettings")}
          message={t("settings.advanced.resetConfirm")}
          confirmLabel={t("settings.advanced.reset")}
          onConfirm={doReset}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === "clear" && (
        <ConfirmDialog
          title={t("settings.advanced.clearData")}
          message={t("settings.advanced.clearConfirm")}
          confirmLabel={t("common.delete")}
          onConfirm={doClear}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

/** The default article-translation engine. "llm" reuses the AI provider
 *  configured for summaries; the rest are standalone machine-translation
 *  services. The reader can override this per translation, but only temporarily. */
type TranslateEngine = "llm" | "google" | "deepl" | "bing";

/** The provider kinds Settings → AI can configure. The wire format each kind
 *  speaks (Anthropic messages vs OpenAI-compatible chat completions) is
 *  decided in `papr_core::ai`; these labels are display-only. */
const AI_KINDS: { value: AiProviderKind; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
];

const kindLabel = (kind: AiProviderKind) =>
  AI_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** Each kind's default model and official endpoint, mirroring
 *  `AiConfig::new` / `Provider::default_base_url`. Used only as input
 *  placeholders — the backend applies the real fallbacks. */
const DEFAULT_MODEL: Record<AiProviderKind, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1-mini",
  deepseek: "deepseek-chat",
};
const DEFAULT_BASE_URL: Record<AiProviderKind, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
};

/** The model the backend will actually call for a provider: the selected
 *  one, else the provider's first, else the kind's default. Mirrors
 *  `AiProfiles::active` so the one-line summary never names a model that
 *  isn't the one in use. */
function effectiveModel(provider: AiProviderEntry, selected: string): string {
  return (
    provider.models.find((m) => m.trim() !== "" && m === selected)?.trim() ||
    provider.models.find((m) => m.trim() !== "")?.trim() ||
    DEFAULT_MODEL[provider.kind]
  );
}

/** Parse the persisted `ai_providers` JSON, returning `null` for anything
 *  unusable (absent, corrupt, or not the shape this build writes) so the
 *  caller falls back to the legacy flat keys. */
function parseAiProfiles(raw: string | null): AiProfiles | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AiProfiles>;
    if (!v || !Array.isArray(v.providers)) return null;
    const providers: AiProviderEntry[] = v.providers
      .filter((p) => p && typeof p.id === "string" && typeof p.kind === "string")
      .map((p) => ({
        id: p.id,
        name: typeof p.name === "string" ? p.name : "",
        kind: AI_KINDS.some((k) => k.value === p.kind) ? p.kind : "anthropic",
        apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
        baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
        models: Array.isArray(p.models)
          ? p.models.filter((m): m is string => typeof m === "string")
          : [],
      }));
    return {
      activeProviderId:
        typeof v.activeProviderId === "string" ? v.activeProviderId : "",
      activeModel: typeof v.activeModel === "string" ? v.activeModel : "",
      providers,
    };
  } catch {
    return null;
  }
}

/** Build the multi-provider config out of the pre-manager flat settings, so
 *  an install upgrading into this layout keeps its single provider (key,
 *  model and endpoint included) without re-entering anything. */
function migrateLegacyProfiles(
  provider: string | null,
  apiKey: string | null,
  model: string | null,
  baseUrl: string | null,
): AiProfiles {
  const kind: AiProviderKind =
    provider === "openai" || provider === "deepseek" || provider === "anthropic"
      ? provider
      : "anthropic";
  const entry: AiProviderEntry = {
    id: "p-legacy",
    name: kindLabel(kind),
    kind,
    apiKey: apiKey ?? "",
    baseUrl: baseUrl ?? "",
    models: model ? [model] : [],
  };
  return {
    activeProviderId: entry.id,
    activeModel: model ?? "",
    providers: [entry],
  };
}

/** One provider card: its credentials plus the models offered under it. The
 *  checked radio is the model summaries and LLM translation currently use.
 *  Text fields persist the whole `ai_providers` JSON on blur; the kind
 *  select and the radios persist immediately. Folded, a card is a single
 *  header line — the default for every provider not in use. */
function AiProviderCard({
  provider,
  active,
  activeModel,
  collapsed,
  onToggle,
  onPatch,
  onRemove,
  onAddModel,
  onPatchModel,
  onCommitModel,
  onRemoveModel,
  onActivate,
}: {
  provider: AiProviderEntry;
  active: boolean;
  activeModel: string;
  collapsed: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<AiProviderEntry>, commit: boolean) => void;
  onRemove: () => void;
  onAddModel: () => void;
  onPatchModel: (index: number, value: string, commit: boolean) => void;
  onCommitModel: (index: number) => void;
  onRemoveModel: (index: number) => void;
  onActivate: (model: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`s-ai-provider${active ? " active" : ""}`}>
      <div className="s-ai-provider-head">
        {collapsed ? (
          <button
            className="s-ai-folded"
            onClick={onToggle}
            aria-expanded={false}
            title={t("settings.ai.expand")}
          >
            <Icon name="chevron-right" size={13} color="var(--muted)" />
            <span className="s-ai-folded-name">
              {provider.name || kindLabel(provider.kind)}
            </span>
            <span className="s-ai-folded-kind">{kindLabel(provider.kind)}</span>
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              onClick={onToggle}
              aria-expanded={true}
              title={t("settings.ai.collapse")}
            >
              <Icon name="chevron-down" size={13} />
            </button>
            <input
              className="s-text-input s-ai-name"
              value={provider.name}
              placeholder={kindLabel(provider.kind)}
              aria-label={t("settings.ai.providerName")}
              {...NO_AUTOCORRECT}
              onChange={(e) => onPatch({ name: e.target.value }, false)}
              onBlur={() =>
                onPatch({ name: provider.name.trim() || kindLabel(provider.kind) }, true)
              }
            />
            <Select
              value={provider.kind}
              options={AI_KINDS}
              onChange={(v) => onPatch({ kind: v }, true)}
              aria-label={t("settings.ai.providerKind")}
            />
          </>
        )}
        <button
          className="icon-btn"
          title={t("settings.ai.removeProvider")}
          onClick={onRemove}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="s-ai-provider-fields">
            <label className="s-ai-field">
              <span>{t("settings.ai.aiApiKey")}</span>
              <input
                className="s-text-input"
                type="password"
                value={provider.apiKey}
                placeholder="sk-…"
                title={t("settings.ai.aiApiKeyDesc")}
                {...NO_AUTOCORRECT}
                onChange={(e) => onPatch({ apiKey: e.target.value }, false)}
                // Trim before persisting — a pasted key routinely carries a
                // trailing newline / space that would break the auth header.
                onBlur={() => onPatch({ apiKey: provider.apiKey.trim() }, true)}
              />
            </label>
            <label className="s-ai-field">
              <span>{t("settings.ai.aiBaseUrl")}</span>
              <input
                className="s-text-input"
                type="text"
                value={provider.baseUrl}
                placeholder={DEFAULT_BASE_URL[provider.kind]}
                title={t("settings.ai.aiBaseUrlDesc")}
                {...NO_AUTOCORRECT}
                onChange={(e) => onPatch({ baseUrl: e.target.value }, false)}
                onBlur={() => onPatch({ baseUrl: provider.baseUrl.trim() }, true)}
              />
            </label>
          </div>
          <div className="s-ai-models">
            <div className="s-ai-models-title">{t("settings.ai.models")}</div>
            {provider.models.map((m, i) => (
              <div className="s-ai-model" key={i}>
                <input
                  type="radio"
                  name="ai-active-model"
                  className="s-ai-model-radio"
                  checked={active && m.trim() !== "" && m === activeModel}
                  onChange={() => onActivate(m)}
                  aria-label={t("settings.ai.activeModel")}
                />
                <input
                  className="s-text-input s-ai-model-name"
                  value={m}
                  placeholder={DEFAULT_MODEL[provider.kind]}
                  aria-label={t("settings.ai.modelName")}
                  {...NO_AUTOCORRECT}
                  onChange={(e) => onPatchModel(i, e.target.value, false)}
                  // Trim before persisting — a stray space / newline yields a
                  // "model not found" from the provider.
                  onBlur={() => onCommitModel(i)}
                />
                <button
                  className="icon-btn"
                  title={t("settings.ai.removeModel")}
                  onClick={() => onRemoveModel(i)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
            <button className="s-btn" onClick={onAddModel}>
              <Icon name="plus" size={12} /> {t("settings.ai.addModel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Real AI provider configuration — backing the AI summary feature, plus the
 *  default translation engine + language and the engines' credentials.
 *  Providers and their models live in the `ai_providers` setting as a set;
 *  exactly one provider+model is selected at a time. */
function AiSettingsGroup({ onToast }: { onToast: (m: string) => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [profiles, setProfiles] = useState<AiProfiles | null>(null);
  // The manager stays folded to its one-line "model in use" summary until
  // asked for; folded provider ids are the ones not in use.
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState<string[]>([]);
  // Default engine + target language for translation. Empty lang = follow the UI
  // language until the user picks one.
  const [engine, setEngine] = useState<TranslateEngine>("llm");
  const [translateLang, setTranslateLang] = useState("");

  /** Adopt a freshly loaded config: everything but the provider in use
   *  starts folded, so the section opens on one quiet line. */
  const apply = (next: AiProfiles) => {
    setProfiles(next);
    setFolded(next.providers.filter((p) => p.id !== next.activeProviderId).map((p) => p.id));
  };
  const toggleFolded = (id: string) =>
    setFolded((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  const persist = (next: AiProfiles) => {
    setProfiles(next);
    return api
      .setSetting("ai_providers", JSON.stringify(next))
      .catch((e) => reportError(e));
  };

  /** Persist a translation preference — engine and target language still
   *  live in their own flat setting keys, one per row. */
  const save = (key: string, value: string, label: string) => {
    api
      .setSetting(key, value)
      .then(() => onToast(t("settings.ai.aiSaved", { label })))
      .catch((e) => reportError(e));
  };

  useEffect(() => {
    Promise.all([
      api.getSetting("ai_providers"),
      api.getSetting("ai_provider"),
      api.getSetting("ai_api_key"),
      api.getSetting("ai_model"),
      api.getSetting("ai_base_url"),
      api.getSetting("translate_engine"),
      api.getSetting("translate_target_lang"),
    ])
      .then(([stored, p, k, m, b, eng, tl]) => {
        const parsed = parseAiProfiles(stored);
        if (parsed) {
          apply(parsed);
        } else {
          // First visit since the multi-provider layout: carry the single
          // provider over and persist it, retiring the flat keys.
          const migrated = migrateLegacyProfiles(p, k, m, b);
          apply(migrated);
          void persist(migrated);
        }
        if (eng === "google" || eng === "deepl" || eng === "bing" || eng === "llm")
          setEngine(eng);
        if (tl) setTranslateLang(tl);
      })
      .catch(() => {});
    // Runs once on mount: the settings are read here and every later edit
    // goes through `persist`, so there is nothing to re-subscribe to.
  }, []);

  /** Apply `patch` to one provider. `commit` persists the whole JSON; text
   *  fields pass `false` while typing and `true` on blur. */
  const patchProvider = (id: string, patch: Partial<AiProviderEntry>, commit: boolean) => {
    if (!profiles) return;
    const next: AiProfiles = {
      ...profiles,
      providers: profiles.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    };
    setProfiles(next);
    if (commit) void persist(next);
  };

  const addProvider = () => {
    if (!profiles) return;
    // A new provider starts as a second credential set for the kind already
    // in use — the common case is another key for the same API family. It
    // opens unfolded so the key and models can be filled in straight away.
    const kind =
      profiles.providers.find((p) => p.id === profiles.activeProviderId)?.kind ?? "anthropic";
    const base = kindLabel(kind);
    const taken = new Set(profiles.providers.map((p) => p.name));
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setOpen(true);
    void persist({
      ...profiles,
      providers: [...profiles.providers, { id, name, kind, apiKey: "", baseUrl: "", models: [] }],
    });
    onToast(t("settings.ai.providerAdded"));
  };

  const removeProvider = (id: string) => {
    if (!profiles) return;
    const removed = profiles.providers.find((p) => p.id === id);
    const providers = profiles.providers.filter((p) => p.id !== id);
    const fallback = providers[0];
    // Removing the provider in use re-points the selection at the first
    // remaining one, so summaries keep working without another visit here.
    const next: AiProfiles =
      profiles.activeProviderId === id
        ? {
            activeProviderId: fallback?.id ?? "",
            activeModel: fallback?.models.find((m) => m.trim() !== "") ?? "",
            providers,
          }
        : { ...profiles, providers };
    // The deleted card leaves the fold state, and a provider the selection
    // just moved to opens so its radio is visible.
    setFolded((f) =>
      profiles.activeProviderId === id
        ? f.filter((x) => x !== id && x !== fallback?.id)
        : f.filter((x) => x !== id),
    );
    void persist(next);
    if (removed)
      onToast(
        t("settings.ai.providerRemoved", {
          name: removed.name || kindLabel(removed.kind),
        }),
      );
  };

  const addModel = (providerId: string) => {
    if (!profiles) return;
    void persist({
      ...profiles,
      providers: profiles.providers.map((p) =>
        p.id === providerId ? { ...p, models: [...p.models, ""] } : p,
      ),
    });
  };

  const patchModel = (providerId: string, index: number, value: string, commit: boolean) => {
    if (!profiles) return;
    const provider = profiles.providers.find((p) => p.id === providerId);
    if (!provider) return;
    // Renaming the model in use moves the selection with it, so the radio
    // stays checked and the backend keeps calling the same model.
    const renamesActive =
      profiles.activeProviderId === providerId && provider.models[index] === profiles.activeModel;
    const next: AiProfiles = {
      ...profiles,
      activeModel: renamesActive ? value : profiles.activeModel,
      providers: profiles.providers.map((p) =>
        p.id === providerId
          ? { ...p, models: p.models.map((m, i) => (i === index ? value : m)) }
          : p,
      ),
    };
    setProfiles(next);
    if (commit) void persist(next);
  };

  const commitModel = (providerId: string, index: number) => {
    const raw = profiles?.providers.find((p) => p.id === providerId)?.models[index];
    if (raw == null) return;
    const trimmed = raw.trim();
    // An abandoned draft row (added, never named) disappears on blur rather
    // than lingering as an unselectable empty entry.
    if (trimmed === "") {
      removeModel(providerId, index);
      return;
    }
    patchModel(providerId, index, trimmed, true);
  };

  const removeModel = (providerId: string, index: number) => {
    if (!profiles) return;
    const removed = profiles.providers.find((p) => p.id === providerId)?.models[index];
    const next: AiProfiles = {
      ...profiles,
      providers: profiles.providers.map((p) =>
        p.id === providerId ? { ...p, models: p.models.filter((_, i) => i !== index) } : p,
      ),
      // Removing the model in use clears the selection; the backend then
      // falls back to the provider's first model (or its kind default).
      activeModel:
        profiles.activeProviderId === providerId && removed === profiles.activeModel
          ? ""
          : profiles.activeModel,
    };
    void persist(next);
  };

  const activate = (providerId: string, model: string) => {
    if (!profiles) return;
    const name = model.trim();
    if (!name) return;
    void persist({ ...profiles, activeProviderId: providerId, activeModel: name });
    // The provider just picked has to show its radio, so it unfolds.
    setFolded((f) => f.filter((x) => x !== providerId));
    onToast(t("settings.ai.modelActivated", { model: name }));
  };

  // The provider the backend resolves to: the selected one, or the first
  // when the selection points at a removed provider — the same fallback
  // order as `AiProfiles::active`.
  const activeProvider =
    profiles?.providers.find((p) => p.id === profiles.activeProviderId) ??
    profiles?.providers[0];

  return (
    <div className="settings-group">
      <h3 className="settings-group-title">{t("settings.ai.aiSummary")}</h3>
      {profiles && profiles.providers.length === 0 ? (
        <>
          <div className="s-ai-empty">{t("settings.ai.noProviders")}</div>
          <button className="s-btn" onClick={addProvider}>
            <Icon name="plus" size={12} /> {t("settings.ai.addProvider")}
          </button>
        </>
      ) : (
        activeProvider && (
          <button
            className="s-ai-active"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={t("settings.ai.manage")}
          >
            <Icon name="sparkle-fill" size={13} color="var(--accent)" />
            <span className="s-ai-active-name">
              {activeProvider.name || kindLabel(activeProvider.kind)}
            </span>
            <span className="s-ai-active-model">
              {effectiveModel(activeProvider, profiles?.activeModel ?? "")}
            </span>
            <Icon
              name={open ? "chevron-down" : "chevron-right"}
              size={13}
              color="var(--muted)"
            />
          </button>
        )
      )}
      {open && profiles && profiles.providers.length > 0 && (
        <>
          <p className="settings-group-desc" style={{ margin: "12px 0 14px" }}>
            {t("settings.ai.providersDesc")}
          </p>
          {profiles.providers.map((p) => (
            <AiProviderCard
              key={p.id}
              provider={p}
              active={p.id === profiles.activeProviderId}
              activeModel={p.id === profiles.activeProviderId ? profiles.activeModel : ""}
              collapsed={folded.includes(p.id)}
              onToggle={() => toggleFolded(p.id)}
              onPatch={(patch, commit) => patchProvider(p.id, patch, commit)}
              onRemove={() => removeProvider(p.id)}
              onAddModel={() => addModel(p.id)}
              onPatchModel={(i, v, commit) => patchModel(p.id, i, v, commit)}
              onCommitModel={(i) => commitModel(p.id, i)}
              onRemoveModel={(i) => removeModel(p.id, i)}
              onActivate={(m) => activate(p.id, m)}
            />
          ))}
          <button className="s-btn" onClick={addProvider}>
            <Icon name="plus" size={12} /> {t("settings.ai.addProvider")}
          </button>
        </>
      )}
      <SummaryPromptEditor onToast={onToast} />
      <Row
        label={t("settings.ai.translateEngine")}
        desc={t("settings.ai.translateEngineDesc")}
      >
        <Select
          value={engine}
          options={[
            { value: "llm", label: t("settings.ai.translateEngineLlm") },
            { value: "google", label: "Google" },
            { value: "deepl", label: "DeepL" },
            { value: "bing", label: "Bing" },
          ]}
          aria-label={t("settings.ai.translateEngine")}
          onChange={(v) => {
            setEngine(v);
            save("translate_engine", v, t("settings.ai.translateEngineLabel"));
            // The reader reads this default when starting a translation —
            // refresh it so the change takes effect on the next translate.
            qc.invalidateQueries({ queryKey: ["setting", "translate_engine"] });
          }}
        />
      </Row>
      <Row
        label={t("settings.ai.translateLang")}
        desc={t("settings.ai.translateLangDesc")}
      >
        <Select
          value={translateLang || i18n.language}
          options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          aria-label={t("settings.ai.translateLang")}
          onChange={(v) => {
            setTranslateLang(v);
            save("translate_target_lang", v, t("settings.ai.translateLangLabel"));
            // The reader caches this default to decide whether a stored
            // translation is still current — refresh it so a change applies now.
            qc.invalidateQueries({ queryKey: ["setting", "translate_target_lang"] });
          }}
        />
      </Row>
      {/* Full-width multi-line field, so it sits outside the label-left /
          control-right row layout. */}
      <PromptEditor
        settingKey="translate_prompt"
        loadBuiltin={api.defaultTranslatePrompt}
        label={t("settings.ai.translatePrompt")}
        desc={t("settings.ai.translatePromptDesc")}
        resetLabel={t("settings.ai.translatePromptReset")}
        onToast={onToast}
      />
    </div>
  );
}

/* ── about ───────────────────────────────────────────────── */
function AboutSection() {
  const { t } = useTranslation();
  const version = useAppVersion();
  return (
    <div className="s-about">
      <div className="mark">
        <Icon name="papr" size={34} color="#fff" />
      </div>
      <h1 className="app-name">Papr</h1>
      <p className="tagline">{t("settings.about.tagline")}</p>
      <div className="version">
        Version{version && ` ${version}`}
      </div>
      <p className="credits">
        {t("settings.about.creditsFonts")}
        <br />
        {t("settings.about.creditsRender")}
        <br />
        {t("settings.about.creditsThanks")}
      </p>
    </div>
  );
}
