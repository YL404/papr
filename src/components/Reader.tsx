import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import { LANGUAGES } from "../i18n";
import { useUi } from "../store";
import { usePlayer } from "../player";
import { useTranslationJobs } from "../translation";
import { useArticleActions } from "../hooks/articleActions";
import { renderMarkdown } from "../lib/markdown";
import { summaryTooShort } from "../lib/summaryGate";
import { downloadBlob, imageFilename } from "../lib/download";
import { imageDataUrl, needsImageProxy, nextImageOriginalUrl } from "../lib/imageBytes";
import { fullDate } from "../lib/feedMeta";
import { isMac } from "../lib/platform";
import { reportError, toast } from "../toast";
import { errorText } from "../lib/errors";
import { tagColor } from "../lib/tagColors";
import type { ArticleDetail } from "../types";
import Icon from "./Icon";
import TagPicker from "./TagPicker";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import Lightbox from "./Lightbox";

interface Props {
  onToast: (msg: string) => void;
}

function youtubeId(url: string | null): string | null {
  if (!url) return null;
  const m =
    url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
  return m ? m[1] : null;
}

/** Plain, entity-decoded text of an HTML body — for the reading-time estimate.
 *  A bare `replace(/<[^>]+>/g, " ")` tag-strip leaves HTML entities intact, so
 *  `Tom &amp; Jerry &mdash; done` would be counted as 5 words / 28 chars when
 *  the real text ("Tom & Jerry — done") is 4 words / 18 chars — inflating the
 *  estimate on entity-heavy articles. Parsing into an inert document decodes
 *  every entity (`&amp;` → `&`, `&mdash;` → `—`) and drops markup cleanly. */
function bodyPlainText(html: string): string {
  if (!html) return "";
  // DOMParser documents are inert — nothing here executes or loads.
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** True when the body opens with its own visual media (image / video / iframe)
 *  before any real text. Such an article already leads with a strong visual, so
 *  prepending the list-thumbnail hero on top of it just shows a second, often
 *  unrelated image — the exact complaint in issue #97, where the body starts
 *  with a `<video>` cover while the feed's `media:thumbnail` is a different png.
 *  Walking in document order (media element before the first non-whitespace text
 *  node) is what the plain `body.includes(imageUrl)` guard can't catch, since
 *  the hero image and the body's lead media are distinct URLs here. */
function bodyLeadsWithMedia(html: string): boolean {
  if (!html) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim().length > 0) return false;
    } else if (node instanceof Element) {
      if (["IMG", "VIDEO", "IFRAME", "PICTURE"].includes(node.tagName)) return true;
    }
  }
  return false;
}

/** CJK ideographs + Japanese kana + Korean Hangul — scripts read by the
 *  character, not the whitespace-delimited word. */
const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯豈-﫿]/u;
/** Global-flagged variant of `CJK_CHAR` for stripping every CJK glyph. */
const CJK_CHAR_GLOBAL = new RegExp(CJK_CHAR.source, "gu");

/** Estimate reading time in minutes for an article body's plain text.
 *
 *  A mixed-script estimate: CJK scripts have no word spacing, so they are
 *  counted by the character (~480 chars/min); latin-script text is counted by
 *  the whitespace-delimited word (~220 wpm). The two contributions are *summed*
 *  — the previous `Math.max(words/220, chars/480)` always lost for English
 *  (a 1000-word article spans ~5500 chars, so `chars/480` ≈ 11 dwarfed the
 *  true `words/220` ≈ 4.5), inflating every latin-script article ~2-3×. */
function estimateReadMinutes(text: string): number {
  let cjkChars = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjkChars++;
  }
  // Words, with CJK characters stripped so they are not also counted as
  // single-character "words" by the latin path.
  const latinWords = text
    .replace(CJK_CHAR_GLOBAL, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const minutes = cjkChars / 480 + latinWords / 220;
  return Math.max(2, Math.round(minutes));
}

/** Decode a URL fragment, tolerating a malformed `%` escape. A real-world
 *  anchor can carry a literal percent (`#100%-growth`, `#section-50%`), which
 *  is not a valid escape sequence — `decodeURIComponent` throws `URIError` on
 *  it. The bare value still works as an `id` lookup, so fall back to it rather
 *  than letting the throw escape the click handler and kill the link. */
function decodeFragment(frag: string): string {
  try {
    return decodeURIComponent(frag);
  } catch {
    return frag;
  }
}

/** Pull the in-page fragment out of a link click, or null if it isn't one.
 *
 *  Two shapes count as in-page: a bare `#frag` href, and — because the body
 *  HTML is sanitized with the article's URL as the rewrite base — an absolute
 *  `https://site/article#frag` that resolves to the very article being read.
 *  `sourceUrl` is the article's own URL, used to recognise that second case.
 */
function inPageFragment(raw: string, sourceUrl: string | null): string | null {
  if (raw[0] === "#") return decodeFragment(raw.slice(1));
  if (!sourceUrl) return null;
  try {
    const u = new URL(raw);
    const b = new URL(sourceUrl);
    if (u.hash && u.origin === b.origin && u.pathname === b.pathname) {
      return decodeFragment(u.hash.slice(1));
    }
  } catch {
    /* not a parseable absolute URL — treat as external */
  }
  return null;
}

/** Build a click handler for links inside injected HTML (article body, AI
 *  summary). In-page anchor links (footnotes, tables of contents) scroll to
 *  their target within the reader; everything else opens in the external
 *  browser — a bare <a> click would otherwise navigate the Tauri webview away
 *  from the app entirely (or, for a fragment link, to a bogus `app://…#frag`). */
function makeLinkClickHandler(sourceUrl: string | null) {
  return (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    const raw = link.getAttribute("href");
    if (!raw) return;
    e.preventDefault();

    const hash = inPageFragment(raw, sourceUrl);
    if (hash != null) {
      if (hash === "") return; // bare `#` — no element to reach
      const root = link.closest(".article-body, .ai-prose");
      // getElementById can't be scoped to the body, so match by id or the
      // legacy `<a name>` form within the rendered content.
      const target = root?.querySelector(
        `[id="${CSS.escape(hash)}"], a[name="${CSS.escape(hash)}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    openUrl(link.href).catch(() => {});
  };
}

/** Every reader image (body, hero, retries) is fetched through the backend and
 *  capped at this size on its longest side before display. The cap keeps the
 *  webview's DECODED bitmap small (pixels × 4 bytes): a full-resolution 3024px
 *  screenshot decodes to ~23MB that WKWebView's image cache drops under
 *  scroll/repaint pressure and re-decodes asynchronously, so the image paints
 *  blank for a beat — the article-image flash. 2048 keeps the worst case near
 *  ~17MB and leaves CDN deliveries under it (Substack serves w_1456)
 *  byte-identical; only "Save image" bypasses the cap to write the original
 *  bytes. */
const READER_IMAGE_MAX_DIM = 2048;

/** Rewrite Next.js optimizer URLs to their original assets and strip every
 *  network image src out of the body before it's injected, keeping the real
 *  address in `data-scout-src` for the scaled-fetch pass (below). Injection
 *  with no src means the webview never even starts a full-resolution load;
 *  the `width`/`height` attributes keep the layout stable while the scaled
 *  data: URLs fill in. Returns the html untouched when it has no such images. */
function prepareBody(body: string, baseUrl: string | null): string {
  if (!body.includes("<img")) return body;
  const doc = new DOMParser().parseFromString(body, "text/html");
  let stripped = false;
  for (const img of doc.body.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    const orig = nextImageOriginalUrl(src, baseUrl) ?? src;
    if (!/^https?:\/\//.test(orig)) continue;
    img.setAttribute("data-scout-src", orig);
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    stripped = true;
  }
  return stripped ? doc.body.innerHTML : body;
}

/** Session cache of filled data: URLs, keyed by the original image URL. Makes
 *  fills survive body re-injections (a re-injected img is re-filled from the
 *  map instantly instead of re-requesting). */
const filledImages = new Map<string, string>();

export default function Reader({ onToast }: Props) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const actions = useArticleActions(toast.error);
  const id = useUi((s) => s.selectedArticleId);
  const focusMode = useUi((s) => s.focusMode);
  const setFocusMode = useUi((s) => s.setFocusMode);
  const markReadOnOpen = useUi((s) => s.prefs.markReadOnOpen);
  const markReadOnScroll = useUi((s) => s.prefs.markReadOnScroll);
  const showReadingTime = useUi((s) => s.prefs.showReadingTime);
  const defaultOpenMode = useUi((s) => s.prefs.defaultOpenMode);

  const [scrolled, setScrolled] = useState(false);
  // Reading progress, 0..1 — see `updateReadProg`.
  const [readProg, setReadProg] = useState(0);
  // Which body to show when an extraction exists follows the default open
  // mode: "reader" (the default) shows the feed's own content and extraction
  // is opt-in via the toolbar button; "extracted" shows the full text.
  const [showExtracted, setShowExtracted] = useState(
    defaultOpenMode === "extracted",
  );
  const [showTranslation, setShowTranslation] = useState(false);
  // Reading vs. the article's original web page, shown in an in-app iframe.
  // Sites that set X-Frame-Options / CSP frame-ancestors refuse to load this
  // way — the in-frame hint points those back to "open in browser".
  const [viewMode, setViewMode] = useState<"reader" | "web">("reader");
  const wide = useUi((s) => s.wide);
  const setWide = useUi((s) => s.setWide);
  const [tagPick, setTagPick] = useState<{ x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    // Set when the right-click landed on an article image / over a text
    // selection, so the menu can offer image- and copy-specific actions.
    imageUrl?: string;
    selection?: string;
  } | null>(null);
  // Full-screen image viewer: the article's image srcs + the one to open on
  // (issue #87). Null when closed.
  const [lightbox, setLightbox] = useState<{ srcs: string[]; index: number } | null>(
    null,
  );
  const [heroBroken, setHeroBroken] = useState(false);
  // data: URL of a hero image recovered through the backend after the webview
  // failed to load it directly (see the body-image retry effect below). A data:
  // URL (not blob:) so the bytes stay inline and survive the webview dropping
  // blob backing data under memory pressure — the same fix as body images.
  const [heroDataUrl, setHeroDataUrl] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Compact docked title strip below the toolbar — see `updateMiniTitle`.
  const miniRef = useRef<HTMLDivElement>(null);
  // Host element the native original-page child webview is positioned over.
  const pageHostRef = useRef<HTMLDivElement>(null);
  // Article id we already auto-marked read via scroll, so a flurry of scroll
  // events near the foot doesn't fire `setRead` repeatedly before the
  // optimistic cache patch lands.
  const scrollMarkedRef = useRef<number | null>(null);
  // Last rendered (blocks, pct) signature of the reading progress — scroll
  // fires far faster than the 28-slot bar or the 2-digit pct can visibly
  // change, so this keeps per-scroll setStates to the frames that matter.
  const readProgSig = useRef("");
  // Scroll position + fraction at the last measure, for the monotonic clamp in
  // `updateReadProg` (the lesson of #28, where the removed hairline bar slid
  // backward as lazy images grew the body mid-scroll).
  const readProgMonRef = useRef<{ scrollTop: number; t: number } | null>(null);
  const playTrack = usePlayer((s) => s.play);
  const playingSrc = usePlayer((s) => (s.playing ? s.track?.src : null));

  const article = useQuery({
    queryKey: ["article", id],
    queryFn: () => api.getArticle(id as number),
    enabled: id != null,
  });
  const a: ArticleDetail | undefined = article.data;

  // Feed list, so the article's source feed can be checked for its per-feed
  // auto-translate flag. Shared cache key with the sidebar — no extra fetch.
  const feeds = useQuery({ queryKey: ["feeds"], queryFn: api.listFeeds });
  const autoTranslateFeed = !!(
    a && feeds.data?.find((f) => f.id === a.feedId)?.autoTranslate
  );
  // Effective open mode (issue #110): the feed's own setting, falling back to
  // the global default. `undefined` while the article or feed list is still
  // loading, so the open-mode/auto-extract effects below don't fire before the
  // feed's own setting is known.
  const feedOpenMode =
    a && feeds.data
      ? feeds.data.find((f) => f.id === a.feedId)?.openMode ?? null
      : undefined;
  const openMode =
    feedOpenMode === undefined ? undefined : feedOpenMode ?? defaultOpenMode;

  const readMinutes = useMemo(() => {
    return estimateReadMinutes(bodyPlainText(a?.extractedHtml || a?.contentHtml || ""));
    // Recompute when the body changes — including after full-text extraction
    // replaces the short feed snippet, which keeps the same article id.
  }, [a?.extractedHtml, a?.contentHtml]);

  /** Compact docked title, driven straight from scroll: as the headline slides
   *  under the toolbar a small centered copy fades in right below the toolbar.
   *  Opacity and an 8px rise track the headline's exit continuously (fully in
   *  once its bottom clears 44px), so the reveal follows the gesture and
   *  reversing the scroll reverses it — no state, no timer. Measured from the
   *  real `<h1>` because the headline's offset varies with the feed/hero
   *  layout above it. */
  const updateMiniTitle = useCallback(() => {
    const h = titleRef.current;
    const m = miniRef.current;
    if (!h || !m) return;
    const p = Math.max(0, Math.min(1, (44 - h.getBoundingClientRect().bottom) / 64));
    m.style.opacity = String(p);
    m.style.transform = `translateY(${((1 - p) * -8).toFixed(2)}px)`;
  }, []);

  // Reset scroll + extraction view on article change.
  useEffect(() => {
    setShowExtracted(useUi.getState().prefs.defaultOpenMode === "extracted");
    setShowTranslation(false);
    setViewMode("reader");
    setScrolled(false);
    readProgSig.current = "";
    readProgMonRef.current = null;
    setReadProg(0);
    setTagPick(null);
    setHeroBroken(false);
    setHeroDataUrl(null);
    scrollMarkedRef.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    // A cached article re-renders without a skeleton, so the strip survives the
    // switch carrying the previous article's scroll-driven styles — re-measure
    // against the now-reset scrollTop instead of waiting for a scroll event.
    updateMiniTitle();
  }, [id, updateMiniTitle]);

  // Apply the effective open mode once the article (and the feed list) is
  // available — declared after the reset above so it wins the same commit.
  // Applied once per article, so the toolbar toggles keep working afterwards
  // and a feeds refetch never yanks the view back.
  const openModeAppliedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!a || openMode === undefined || openModeAppliedRef.current === a.id)
      return;
    openModeAppliedRef.current = a.id;
    if (openMode === "web" && a.url) setViewMode("web");
    else setShowExtracted(openMode === "extracted");
  }, [a, openMode]);

  // Drive the native original-page child webview (page_view.rs) while in web
  // mode. It floats above the DOM, so we measure the host rect and keep the
  // webview aligned to it across window/sidebar resizes. (Switching articles
  // resets viewMode to "reader" above, so a.url is stable within a session.)
  const articleUrl = a?.url ?? null;
  // Anything that floats over the reading area must suspend the page view: the
  // child webview floats above the whole DOM, so it would otherwise occlude a
  // covering modal (subscribe / settings — issue #54), a context
  // menu raised over the reader (issue #74), or the tag picker. We *hide* the
  // webview rather than tear it down, so dismissing the overlay reveals the
  // already-loaded page instantly instead of reloading it (the bounds keep
  // syncing while hidden, below).
  const modalOpen = useUi((s) => s.modalOpen);
  const menuOpen = useUi((s) => s.menuOpen);
  const overlayOpen = modalOpen || menuOpen || tagPick != null;
  // Read the latest value inside the lifecycle effect without making it a
  // dependency — overlays toggle visibility (below), never the webview's life.
  const overlayOpenRef = useRef(overlayOpen);
  overlayOpenRef.current = overlayOpen;

  // Webview lifecycle: create on entering web mode (or when the article's URL
  // changes), destroy on leaving. Bounds track the host across resizes even
  // while hidden, so re-showing never lands the page at a stale rect.
  useEffect(() => {
    const host = pageHostRef.current;
    if (viewMode !== "web" || !articleUrl || !host) return;

    const bounds = () => {
      const r = host.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    let open = false;
    let cancelled = false;
    api.openPageView(articleUrl, bounds()).then(
      () => {
        open = true;
        // If teardown ran while this open was still in flight, the cleanup's
        // closePageView fired against a not-yet-created webview (a no-op) and
        // would leave this one orphaned above the DOM — close it now.
        if (cancelled) {
          api.closePageView().catch(() => {});
          return;
        }
        // Created visible by default; if an overlay is already up (e.g. a
        // context menu was open when web mode was toggled on), hide it at once.
        if (overlayOpenRef.current) api.setPageViewVisible(false).catch(() => {});
      },
      () => {},
    );

    const sync = () => {
      if (open && !cancelled) api.setPageViewBounds(bounds()).catch(() => {});
    };
    const ro = new ResizeObserver(sync);
    ro.observe(host);
    window.addEventListener("resize", sync);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", sync);
      api.closePageView().catch(() => {});
    };
  }, [viewMode, articleUrl]);

  // Visibility: toggle the webview as overlays come and go, without reloading.
  // No-op (backend-side) when no webview is open.
  useEffect(() => {
    if (viewMode !== "web" || !articleUrl) return;
    api.setPageViewVisible(!overlayOpen).catch(() => {});
  }, [overlayOpen, viewMode, articleUrl]);

  // Recover article-body images the webview fails to load, then hide the
  // stragglers. The webview sends no Referer (see sanitize.rs) — right for
  // blacklist-style hotlink protection (*.sinaimg.cn) but fatal on hosts that
  // *require* one (cdnfile.sspai.com 403s a bare request), and the webview
  // can't vary the value per host. So a failed image gets one retry through
  // the backend, which walks Referer fallbacks (fetch_image_scaled) and
  // returns display-sized bytes; the <img> is swapped to an inline data: URL,
  // with the original kept in data-scout-src for the context-menu actions. A
  // data: URL (not blob:) is
  // deliberate — WKWebView/WebView2 silently drop a blob:'s backing data under
  // memory pressure (e.g. layer recompositing while scrolling), so a recovered
  // image carried by a blob: vanishes when the user scrolls away and back; the
  // inline data: bytes always repaint. Images the backend can't recover are
  // hidden — a broken-image icon mid-article is just noise. Runs whenever the
  // body changes (article switch, extract toggle, extraction finishing).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const pageUrl = a?.url;
    const timers: number[] = [];
    let alive = true;
    const recover = async (img: HTMLImageElement) => {
      const src = img.getAttribute("src") || "";
      if (img.dataset.scoutRetried || !/^https?:\/\//.test(src)) {
        img.style.display = "none";
        return;
      }
      img.dataset.scoutRetried = "1";
      try {
        const buf = await api.fetchImageScaled(src, pageUrl, READER_IMAGE_MAX_DIM);
        if (!alive) return;
        img.dataset.scoutSrc = src;
        img.src = imageDataUrl(src, buf);
      } catch {
        img.style.display = "none";
      }
    };
    const recoverIfBroken = (img: HTMLImageElement) => {
      if (img.dataset.scoutRetried) return;
      // An img still waiting for the scaled-fetch pass has no src yet — not
      // broken, just pending. `complete` is trivially true for a src-less img,
      // so it needs this guard to stay out of the retry path.
      if (!img.getAttribute("src")) return;
      if (img.complete && img.naturalWidth === 0) void recover(img);
    };
    const onError = (e: Event) => void recover(e.currentTarget as HTMLImageElement);
    const watched: HTMLImageElement[] = [];
    el.querySelectorAll("img").forEach((img) => {
      // Articles stored before the sanitizer began forcing `loading="eager"`
      // still carry the feed's `loading="lazy"` — flip it here so deferred
      // images start loading now instead of popping in blank mid-scroll.
      // Sanitize runs at ingestion, so it never rewrites existing DB rows.
      img.loading = "eager";
      // Sync decode as the flicker backstop: when a content tile that contains
      // images re-rasterizes after the webview dropped its raster, the paint
      // waits for the decode instead of committing a blank frame first.
      img.decoding = "sync";
      img.addEventListener("error", onError);
      watched.push(img);
      // Body images start src-less (the scaled-fetch pass fills them in), so
      // this only retries an image that already failed with a src in place —
      // a restored original URL the webview also couldn't load. `onError`
      // above covers failures reported after this pass.
      recoverIfBroken(img);
    });
    // WKWebView can finish a parser-inserted image before React's effect
    // listener is attached, and in practice not every broken image reports
    // that state synchronously. A few delayed sweeps make the fallback
    // deterministic without retrying images that are still loading.
    [250, 1000, 2500].forEach((delay) => {
      timers.push(window.setTimeout(() => watched.forEach(recoverIfBroken), delay));
    });
    return () => {
      alive = false;
      timers.forEach(window.clearTimeout);
      watched.forEach((img) => img.removeEventListener("error", onError));
    };
  }, [a?.id, a?.url, showExtracted, a?.extractedHtml, showTranslation, a?.translatedHtml]);

  // Same proactive proxy for the reader hero. These hosts need a Referer that
  // only the Rust fetch path can provide; waiting for `onError` leaves a broken
  // image visible in WKWebView on some builds.
  useEffect(() => {
    if (!a?.imageUrl || heroDataUrl || heroBroken || !needsImageProxy(a.imageUrl)) return;
    let alive = true;
    const articleId = a.id;
    api
      .fetchImageScaled(a.imageUrl, a.url, READER_IMAGE_MAX_DIM)
      .then((buf) => {
        if (!alive || useUi.getState().selectedArticleId !== articleId) return;
        setHeroDataUrl(imageDataUrl(a.imageUrl!, buf));
      })
      .catch(() => {
        if (!alive || useUi.getState().selectedArticleId !== articleId) return;
        setHeroBroken(true);
      });
    return () => {
      alive = false;
    };
  }, [a?.id, a?.imageUrl, a?.url, heroDataUrl, heroBroken]);

  // Mark as read once when an unread article is opened (if the user opted in).
  useEffect(() => {
    if (a && !a.isRead && markReadOnOpen) actions.setRead(a.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id]);

  // The extracted article id travels as the mutation variable, not via the
  // `a` closure: extraction is async and the user can switch articles before
  // it resolves. Keying onSuccess off the live `a` would invalidate the wrong
  // article (the extracted text never shows on return) and toast "full text
  // extracted" while reading an unrelated, un-extracted article.
  const extract = useMutation({
    mutationFn: (articleId: number) => api.extractFulltext(articleId),
    onSuccess: (_data, articleId) => {
      qc.invalidateQueries({ queryKey: ["article", articleId] });
      // Only the article still on screen should flip into the extracted view
      // and surface the toast.
      if (useUi.getState().selectedArticleId === articleId) {
        setShowExtracted(true);
        onToast(t("reader.fullTextExtracted"));
      }
    },
    onError: (e) => reportError(e),
  });

  // The default translation target + engine, switched inline from the toolbar
  // The default target language + engine come from Settings. The toolbar can
  // override them per translation, but only temporarily: the override is not
  // written back and resets to the default when switching articles. The article's
  // cached `translatedLang` (and any running job's `lang`) is compared against the
  // effective `targetLang` to decide whether a translation is current for it.
  const translateSetting = useQuery({
    queryKey: ["setting", "translate_target_lang"],
    queryFn: () => api.getSetting("translate_target_lang"),
  });
  const defaultLang = translateSetting.data || i18n.language;
  const engineSetting = useQuery({
    queryKey: ["setting", "translate_engine"],
    queryFn: () => api.getSetting("translate_engine"),
  });
  const defaultEngine = engineSetting.data || "llm";
  // `null` = follow the default; a string = a temporary per-article override.
  const [tmpLang, setTmpLang] = useState<string | null>(null);
  const [tmpEngine, setTmpEngine] = useState<string | null>(null);
  const targetLang = tmpLang ?? defaultLang;
  const engine = tmpEngine ?? defaultEngine;
  // Drop the temporary overrides when the article changes so each article opens
  // on the configured defaults.
  useEffect(() => {
    setTmpLang(null);
    setTmpEngine(null);
  }, [id]);

  // Background translation jobs run independently of this view, so several
  // articles can translate at once and switching away never interrupts one.
  const startTranslate = useTranslationJobs((s) => s.translate);
  const job = useTranslationJobs((s) => (id != null ? s.jobs[id] : undefined));

  const hasExtracted = !!a?.extractedHtml;
  const canTranslate = !!(a?.extractedHtml || a?.contentHtml);
  const baseBody =
    (showExtracted && a?.extractedHtml ? a.extractedHtml : a?.contentHtml) || "";
  const jobForTarget = job && job.lang === targetLang ? job : undefined;
  const translating = jobForTarget?.status === "translating";
  const cachedValid = !!a?.translatedHtml && a.translatedLang === targetLang;
  const translatedBody =
    jobForTarget?.html || (cachedValid ? a?.translatedHtml ?? "" : "");
  const hasTranslation = !!translatedBody;
  const showToggle = hasTranslation || translating;
  const body = showTranslation
    ? translatedBody ||
      (translating ? `<p><em>${t("reader.translating")}</em></p>` : baseBody)
    : baseBody;
  const displayBody = useMemo(
    () => prepareBody(body, a?.url ?? null),
    [body, a?.url],
  );
  // The injected-HTML prop object must be referentially stable while the string
  // is unchanged: React 19's host-update path compares prop values by identity
  // (`===`) and its `dangerouslySetInnerHTML` branch assigns innerHTML
  // unconditionally, so an inline `{ __html: ... }` literal — a new object on
  // every render — makes every scroll/hover-driven re-render of the reader
  // re-set the whole body, reloading every image and flashing them (the
  // article-image flicker). Memoising on the string keeps re-renders from
  // touching the DOM at all, and a changed string still lands.
  const bodyHtml = useMemo(
    () => ({ __html: displayBody || `<p><em>${t("reader.noContent")}</em></p>` }),
    [displayBody, t],
  );
  // Whether the body already opens with its own image/video — if so, the hero
  // thumbnail is suppressed to avoid a redundant top image (issue #97).
  const leadsWithMedia = useMemo(() => bodyLeadsWithMedia(baseBody), [baseBody]);

  // For hosts that require a Referer (notably 少数派's image CDN) the plain
  // webview load fails (no per-host Referer control); and full-resolution
  // sources decode to bitmaps the webview drops and re-decodes under scroll
  // pressure. So every network body image goes through the backend instead:
  // `prepareBody` strips the srcs before injection (above), and this pass
  // fetches each one downscaled and swaps its data: URL in on the live DOM —
  // no innerHTML reset, so already-filled images never reload. A failed fetch
  // hands the original URL to the webview's own loader rather than hiding the
  // image; the recovery effect below still hides it if that fails too.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let alive = true;
    const fill = async (img: HTMLImageElement) => {
      const src = img.dataset.scoutSrc;
      if (!src) return;
      // A re-injected body (article switch, translation toggle) wipes img srcs;
      // the session map re-fills those from memory without an IPC round trip.
      const cached = filledImages.get(src);
      if (cached) {
        img.src = cached;
        return;
      }
      try {
        const buf = await api.fetchImageScaled(src, a?.url, READER_IMAGE_MAX_DIM);
        if (!alive || !img.isConnected) return;
        const dataUrl = imageDataUrl(src, buf);
        if (filledImages.size >= 40) filledImages.clear();
        filledImages.set(src, dataUrl);
        img.src = dataUrl;
      } catch {
        if (!alive || !img.isConnected) return;
        img.src = src;
      }
    };
    for (const img of el.querySelectorAll<HTMLImageElement>(
      "img[data-scout-src]",
    )) {
      if (img.getAttribute("src")) continue; // already filled or restored
      void fill(img);
    }
    return () => {
      alive = false;
    };
  }, [displayBody, a?.url]);

  // The external-link arrow is drawn by the stylesheet for every body link with
  // an href (see `.article-body a[href]:not([href^="#"])::after`), so it can
  // never be lost to a marking pass that runs early or not at all. CSS already
  // spares bare `#fragment` anchors and links wrapping a block or an image; the
  // one case it cannot see is a same-page URL written out in full
  // (`https://site/post#fn1`), which scrolls inside the reader just like a bare
  // fragment does. `inPageFragment` — the same helper the click handler uses —
  // is what tells the two apart.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const sourceUrl = a?.url ?? null;
    for (const link of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      link.removeAttribute("data-scout-inpage");
      if (inPageFragment(link.getAttribute("href")!, sourceUrl) != null) {
        link.setAttribute("data-scout-inpage", "");
      }
    }
  }, [displayBody, a?.url, viewMode]);

  // When a translation finishes, refetch the article so its persisted
  // `translatedHtml` lands in the cache — the toggle then keeps working after
  // the in-memory job is gone (e.g. reopening the article in a later session).
  useEffect(() => {
    if (id == null || !job) return;
    if (job.status === "done") {
      qc.invalidateQueries({ queryKey: ["article", id] });
    } else if (job.status === "error") {
      // The translation failed (a toast already surfaced why) — drop back to the
      // original so the view isn't stuck on an empty "translating…" state.
      setShowTranslation(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, job?.status]);

  // With an "extracted" open mode in effect, a summary-only feed item is
  // upgraded to the full page the moment it's opened, so the reader never
  // shows a two-line stub. Skipped when the feed already carries the whole
  // article, when there is no source URL to fetch, or once attempted for this
  // article — so a failed fetch isn't retried on every re-render.
  const autoExtractedRef = useRef<number | null>(null);
  useEffect(() => {
    if (openMode !== "extracted" || !a || !a.url || a.extractedHtml) return;
    if (autoExtractedRef.current === a.id || extract.isPending) return;
    // Measure the *decoded* text, not the raw markup. A bare `<[^>]+>` tag
    // strip leaves HTML entities intact, so an entity-heavy stub
    // (`&nbsp;`-padded copy, `&mdash;`/`&amp;` runs) is over-counted — a
    // genuinely short snippet can clear the 800-char bar and wrongly look
    // "complete", leaving the reader showing the very stub auto-extract is
    // meant to replace. `bodyPlainText` decodes entities and drops markup
    // cleanly, the same measurement the reading-time estimate already uses.
    // An explicit per-feed "extracted" skips the bar entirely — the user asked
    // for the page's own text even when the feed body looks complete.
    if (feedOpenMode !== "extracted") {
      const plain = bodyPlainText(a.contentHtml || "").trim();
      if (plain.length >= 800) return; // feed already delivers the full text
    }
    autoExtractedRef.current = a.id;
    extract.mutate(a.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id, a?.extractedHtml, openMode, feedOpenMode]);

  // Per-feed auto-translate: when the article's source feed opts in, translate
  // it into the configured target the moment it opens. Fires once per article
  // (guarded by `autoTranslatedRef`), only when there's a body to translate and
  // a usable cached translation in the target language isn't already present —
  // so a feed left untouched still shows its original text, and reopening a
  // cached article doesn't re-spend an API call. The toolbar toggle still lets
  // the reader flip back to the original at any time.
  const autoTranslatedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!autoTranslateFeed || !a || !canTranslate) return;
    if (autoTranslatedRef.current === a.id) return;
    autoTranslatedRef.current = a.id;
    // A fresh cached translation for the target language needs no new job;
    // just surface it. Otherwise start a background translation.
    if (!(a.translatedHtml && a.translatedLang === targetLang)) {
      startTranslate(a.id, targetLang, engine);
    }
    setShowTranslation(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id, autoTranslateFeed, canTranslate, targetLang, engine]);

  // Mark the current article read once its foot is reached. Also fires for an
  // article short enough to need no scrolling at all (`scrollHeight` already
  // within `clientHeight`) — that case produces no `scroll` event, so without
  // a render-time check a fully-visible short article would never be marked
  // read despite "mark read on scroll" being on.
  const markReadIfAtFoot = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !markReadOnScroll || !a || a.isRead) return;
    if (scrollMarkedRef.current === a.id) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      scrollMarkedRef.current = a.id;
      actions.setRead(a.id, true);
    }
  }, [markReadOnScroll, a, actions]);

  /** Fraction of the article read, after claude.dev's blog reading bar: 100%
   *  lands when the article's foot reaches the container's foot — not at the
   *  scroll container's padded end — and a body shorter than the viewport is
   *  fully read. The fraction only regresses on a genuine scroll-up (#28):
   *  lazy images keep growing the body mid-read, and a raw fraction would
   *  slide backward while the reader only moved down. Only the rendered
   *  signature (28 blocks / 2-digit pct) is allowed to trigger a re-render. */
  const updateReadProg = useCallback(() => {
    const el = scrollRef.current;
    const art = el?.firstElementChild as HTMLElement | null;
    if (!el || !art) return;
    // Article top in content coordinates (rect diff is scroll-dependent, so
    // re-add scrollTop) — offsetTop would resolve against .reader, not this
    // scroll container.
    const top =
      art.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop;
    const foot = top + art.offsetHeight - el.clientHeight;
    const t = foot <= 0 ? 1 : Math.max(0, Math.min(1, el.scrollTop / foot));
    const prev = readProgMonRef.current;
    const monotonic =
      prev && el.scrollTop >= prev.scrollTop ? Math.max(t, prev.t) : t;
    readProgMonRef.current = { scrollTop: el.scrollTop, t: monotonic };
    const sig = `${Math.round(monotonic * 28)}/${Math.round(monotonic * 100)}`;
    if (sig !== readProgSig.current) {
      readProgSig.current = sig;
      setReadProg(monotonic);
    }
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrolled(el.scrollTop > 8);
    updateReadProg();
    updateMiniTitle();
    markReadIfAtFoot();
  };

  // A short article that fits the viewport never fires `scroll`, so check the
  // foot condition once the body has laid out (article switch, extract toggle,
  // extraction finishing). The check is deferred briefly so body images have a
  // chance to load — measuring `scrollHeight` before they do could read a
  // too-small height and mark a genuinely long article read prematurely. The
  // `scrollMarkedRef` guard keeps it idempotent. The same settle delay re-measures
  // the progress bar, whose height also moves as images load.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      updateReadProg();
      updateMiniTitle();
      markReadIfAtFoot();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [updateReadProg, updateMiniTitle, markReadIfAtFoot, showExtracted, a?.extractedHtml, a?.contentHtml]);

  // Progress also moves without a scroll event whenever the body's height
  // changes in place — extract/translation swaps and the wide toggle reflow
  // the article — so re-measure as soon as they land.
  useEffect(() => {
    updateReadProg();
  }, [updateReadProg, displayBody, viewMode, wide]);


  const copyLink = () => {
    if (!a?.url) return;
    navigator.clipboard.writeText(a.url).then(() => onToast(t("reader.linkCopied")), () => {});
  };
  const copyText = (text: string, toastKey: string) => {
    navigator.clipboard.writeText(text).then(() => onToast(t(toastKey)), () => {});
  };
  // Save a feed image to disk. The bytes are fetched in Rust (not the webview)
  // so the request's Referer can walk the same hotlink-protection fallbacks
  // that let these images render at all (see fetch_image). The download itself
  // reuses the app's blob-anchor mechanism.
  const saveImage = async (url: string) => {
    try {
      const buf = await api.fetchImage(url, a?.url);
      downloadBlob(new Blob([buf]), imageFilename(url));
    } catch {
      toast.error(t("reader.imageSaveFailed"));
    }
  };
  const share = () => {
    if (!a?.url) return;
    if (navigator.share) {
      navigator.share({ title: a.title, url: a.url }).catch((e) => {
        // A user-cancelled share rejects with AbortError — only fall back to
        // copying the link on a genuine failure (e.g. share unsupported).
        if ((e as Error)?.name !== "AbortError") copyLink();
      });
    } else {
      copyLink();
    }
  };

  // Article-body clicks: an image opens the full-screen viewer (issue #87), with
  // the article's other images available for ← / → navigation; anything else
  // falls through to the link handler (in-page anchors, external links).
  const linkClick = makeLinkClickHandler(a?.url ?? null);
  const handleBodyClick = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest("img") as HTMLImageElement | null;
    const root = bodyRef.current;
    if (img && root?.contains(img)) {
      // Use the src the DOM actually renders — a proxied data: URL when the
      // original hotlink-protected host needed a Referer — and skip hidden /
      // broken images so the gallery matches what the reader shows.
      const imgs = Array.from(
        root.querySelectorAll<HTMLImageElement>("img"),
      ).filter(
        (im) => im.style.display !== "none" && (im.currentSrc || im.getAttribute("src")),
      );
      const index = imgs.indexOf(img);
      if (index >= 0) {
        e.preventDefault();
        setLightbox({ srcs: imgs.map((im) => im.currentSrc || im.src), index });
        return;
      }
    }
    linkClick(e);
  };

  if (id == null) {
    const kbd = {
      fontFamily: "var(--mono)",
      fontSize: 10,
      padding: "1px 5px",
      border: "1px solid var(--hair)",
      borderRadius: 3,
    };
    return (
      <div className="reader" role="main">
        {isMac && <div className="reader-toolbar" data-tauri-drag-region />}
        <div className="empty" style={{ flex: 1 }}>
          <div className="glyph">
            <Icon name="rss" size={22} />
          </div>
          <div>{t("reader.emptySelectArticle")}</div>
          <div style={{ fontSize: 11.5, color: "var(--muted-2)" }}>
            {t("reader.emptyHintPrefix")} <kbd style={kbd}>J</kbd> /{" "}
            <kbd style={kbd}>K</kbd> {t("reader.emptyHintSuffix")}
          </div>
        </div>
      </div>
    );
  }

  // An article is selected but its detail isn't loaded yet — still fetching
  // or the fetch failed. Surface that explicitly instead of falling through
  // to the "select an article" empty state, which would be misleading.
  if (!a) {
    return (
      <div className="reader" role="main">
        {isMac && <div className="reader-toolbar" data-tauri-drag-region />}
        {article.isError ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="glyph">
              <Icon name="alert" size={22} />
            </div>
            <div>{t("reader.loadError")}</div>
            <button
              className="empty-retry"
              onClick={() => article.refetch()}
              disabled={article.isFetching}
            >
              <Icon name="refresh" size={12} />
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <div className="reader-scroll">
            <div className="article reader-content" aria-hidden="true">
              <div className="sk-line" style={{ width: "28%" }} />
              <div
                className="sk-line"
                style={{ width: "82%", height: 24, marginBottom: 18 }}
              />
              <div
                className="sk-line"
                style={{ width: "44%", marginBottom: 30 }}
              />
              {Array.from({ length: 9 }).map((_, i) => (
                <div
                  key={i}
                  className="sk-line"
                  style={{ width: i % 3 === 2 ? "58%" : "100%", height: 12 }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // `hasExtracted`, `canTranslate`, `body`, `displayBody` and the translation
  // state are computed above (before the early returns) so the image-proxy and
  // recovery effects can depend on them.

  // Translate into `lang` with `eng` and show the result. Defaults come from
  // Settings; the toolbar passes temporary overrides here (not persisted). Always
  // starts a fresh job (the store skips only a duplicate in-flight one).
  const run = (lang: string, eng: string) => {
    if (!canTranslate) return;
    startTranslate(a.id, lang, eng);
    setShowTranslation(true);
  };

  const ytId = a.sourceType === "youtube" ? youtubeId(a.url) : null;

  // The block-bar reading progress: 28 slots after the source design, filled
  // ones drawn ▓ over ░, with a zero-padded percentage on the right.
  const progFilled = Math.round(readProg * 28);

  const metaItems: React.ReactNode[] = [];
  if (a.author) {
    metaItems.push(
      <span key="author" className="author">
        {a.author}
      </span>,
    );
  }
  if (a.publishedAt) {
    metaItems.push(
      <span key="published">{fullDate(a.publishedAt)}</span>,
    );
  }
  if (showReadingTime) {
    metaItems.push(
      <span key="reading-time">
        {t("reader.readMinutes", { count: readMinutes })}
      </span>,
    );
  }
  if (extract.isPending) {
    metaItems.push(
      <span key="extracting">{t("reader.extractingFullText")}</span>,
    );
  }

  return (
    <div className="reader" role="main">
      <div
        className={`reader-toolbar ${scrolled ? "scrolled" : ""}`}
        {...(isMac && { "data-tauri-drag-region": true })}
      >
        <button
          className={`tb-btn ${a.isStarred ? "on" : ""}`}
          onClick={() => actions.setStarred(a.id, !a.isStarred)}
          title={t("reader.tbStar")}
          aria-label={t("reader.tbStar")}
          aria-pressed={a.isStarred}
        >
          <Icon name={a.isStarred ? "star-fill" : "star"} size={16} />
        </button>
        <button
          className={`tb-btn ${a.readLater ? "on" : ""}`}
          onClick={() => actions.setReadLater(a.id, !a.readLater)}
          title={t("reader.tbReadLater")}
          aria-label={t("reader.tbReadLater")}
          aria-pressed={a.readLater}
        >
          <Icon name={a.readLater ? "bookmark-fill" : "bookmark"} size={16} />
        </button>
        <button
          className={`tb-btn ${a.tags.length > 0 ? "on" : ""}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTagPick((p) => (p ? null : { x: r.left, y: r.bottom + 6 }));
          }}
          title={t("reader.tbTags")}
          aria-label={t("reader.tbTags")}
          aria-haspopup="menu"
          aria-expanded={tagPick != null}
        >
          <Icon name="tag" size={16} />
        </button>
        <button
          className={`tb-btn ${hasExtracted && showExtracted ? "on" : ""} ${
            extract.isPending ? "spinning" : ""
          }`}
          onClick={() =>
            hasExtracted ? setShowExtracted((v) => !v) : extract.mutate(a.id)
          }
          // Extraction needs the source URL; without one (and nothing
          // extracted yet) the button can only error, so disable it.
          disabled={extract.isPending || (!hasExtracted && !a.url)}
          title={hasExtracted ? t("reader.tbToggleFullText") : t("reader.tbExtractFullText")}
          aria-label={hasExtracted ? t("reader.tbToggleFullText") : t("reader.tbExtractFullText")}
          aria-pressed={hasExtracted ? showExtracted : undefined}
          aria-busy={extract.isPending}
        >
          <Icon name="text" size={16} />
        </button>
        <button
          className="tb-btn"
          title={t("reader.tbShare")}
          aria-label={t("reader.tbShare")}
          onClick={share}
          disabled={!a.url}
        >
          <Icon name="share" size={16} />
        </button>
        <button
          className={`tb-btn ${showTranslation ? "on" : ""}`}
          title={t("reader.tbTranslate")}
          aria-label={t("reader.tbTranslate")}
          aria-pressed={showTranslation}
          disabled={!canTranslate}
          onClick={() =>
            // One click: translate with the default language + engine, or flip
            // back to the original. Switch engine/language inline on the toggle.
            showTranslation ? setShowTranslation(false) : run(targetLang, engine)
          }
        >
          <Icon name="globe" size={16} />
        </button>
        <div className="tb-btn spacer" />
        <button
          className={`tb-btn ${wide ? "on" : ""}`}
          title={t("reader.tbWideMode")}
          aria-label={t("reader.tbWideMode")}
          aria-pressed={wide}
          onClick={() => setWide(!wide)}
        >
          <Icon name="wide" size={16} />
        </button>
        {a.url && (
          <button
            className={`tb-btn ${viewMode === "web" ? "on" : ""}`}
            title={t("reader.tbWebView")}
            aria-label={t("reader.tbWebView")}
            aria-pressed={viewMode === "web"}
            onClick={() => setViewMode((v) => (v === "web" ? "reader" : "web"))}
          >
            <Icon name="eye" size={16} />
          </button>
        )}
        {a.url && (
          <button
            className="tb-btn"
            title={t("reader.tbOpenInBrowser")}
            aria-label={t("reader.tbOpenInBrowser")}
            onClick={() => openUrl(a.url!).catch(() => {})}
          >
            <Icon name="open" size={16} />
          </button>
        )}
        {viewMode === "reader" && (
          <div className="read-prog" aria-hidden="true">
            <b>{"▓".repeat(progFilled)}</b>
            {"░".repeat(28 - progFilled)}
            <span>{String(Math.round(readProg * 100)).padStart(2, "0")}%</span>
          </div>
        )}
      </div>

      {/* Docked compact title (styles: `.mini-title`). Positioned below the
          toolbar, over the scroll content; scroll-driven styles come from
          `updateMiniTitle`. Hidden in web mode — the native page view has no
          DOM scroll to track, same as `.read-prog`. */}
      {viewMode === "reader" && (
        <div className="mini-title" ref={miniRef} aria-hidden="true">
          <span className="mini-feed">{a.feedTitle}</span>
          <span className="mini-sep">·</span>
          <span className="mini-text">{a.title}</span>
        </div>
      )}

      {viewMode === "web" && a.url ? (
        <div className="reader-webview">
          <div className="reader-webview-bar">
            <span className="reader-webview-url">{a.url}</span>
            <button
              className="reader-webview-open"
              onClick={() => openUrl(a.url!).catch(() => {})}
            >
              {t("reader.tbOpenInBrowser")}
            </button>
          </div>
          {/* The native child webview (page_view.rs) floats over this host —
              it's not in the DOM, so this div only reserves the space. The
              effect below measures it and positions the webview to match. */}
          <div className="reader-webview-host" ref={pageHostRef} />
        </div>
      ) : (
      <div
        className="reader-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onContextMenu={(e) => {
          e.preventDefault();
          // Capture what the click landed on so the menu can add image- and
          // selection-specific actions (the native menu is suppressed app-wide;
          // see main.tsx).
          const img = (e.target as HTMLElement).closest("img") as HTMLImageElement | null;
          const sel = window.getSelection();
          const selection =
            sel && !sel.isCollapsed ? sel.toString().trim() : "";
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            // data-scout-src holds the real address when the image was
            // recovered through the backend and src is an inline data: URL.
            imageUrl: img?.dataset.scoutSrc || img?.currentSrc || img?.getAttribute("src") || undefined,
            selection: selection || undefined,
          });
        }}
      >
        <article className={`article reader-content ${wide ? "wide" : ""}`} key={a.id}>
          <button
            type="button"
            className="article-feed"
            title={t("reader.viewAllFromFeed")}
            onClick={() =>
              useUi.getState().select({ kind: "feed", value: a.feedId }, a.feedTitle)
            }
          >
            <Icon name="rss" size={13} />
            {a.feedTitle}
          </button>
          <h1 className="article-title" ref={titleRef}>{a.title}</h1>
          {metaItems.length > 0 && (
            <div className="article-meta">
              {metaItems.map((item, idx) => (
                <Fragment key={idx}>
                  {idx > 0 && <span>·</span>}
                  {item}
                </Fragment>
              ))}
            </div>
          )}

          {a.tags.length > 0 && (
            <div className="article-tags">
              {a.tags.map((tag) => (
                <button
                  key={tag.id}
                  className="article-tag"
                  style={{ "--tag-c": tagColor(tag.color) } as React.CSSProperties}
                  onClick={() =>
                    useUi.getState().select({ kind: "tag", value: tag.id }, tag.name)
                  }
                >
                  <span className="tag-dot" />
                  {tag.name}
                </button>
              ))}
            </div>
          )}

          <AISummary article={a} />

          {ytId ? (
            <iframe
              style={{ width: "100%", aspectRatio: "16 / 9" }}
              // Privacy-enhanced host: YouTube sets no tracking cookies
              // until the viewer actually starts the video.
              src={`https://www.youtube-nocookie.com/embed/${ytId}`}
              title={a.title}
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          ) : (
            a.imageUrl &&
            !heroBroken &&
            // Skip the hero when the body already embeds the same image, so
            // feeds that repeat their lead image don't show it twice.
            !body.includes(a.imageUrl) &&
            // Also skip it when the body opens with its own image/video — the
            // article already leads with a visual, so a separate thumbnail on
            // top would just be a redundant (often mismatched) image (#97).
            !leadsWithMedia && (
              <img
                className="reader-hero"
                src={heroDataUrl ?? a.imageUrl}
                alt=""
                // The original URL when src is a recovered data: URL, so the
                // context-menu copy/save actions see a real address.
                data-scout-src={heroDataUrl ? a.imageUrl : undefined}
                // No Referer, for the same hotlink-protection reason feed-body
                // images are sanitized this way (e.g. *.sinaimg.cn 403s a
                // request carrying our origin). See `sanitize`.
                referrerPolicy="no-referrer"
                // Same recovery as body images: hosts that *require* a Referer
                // (cdnfile.sspai.com) 403 the direct load, so retry through
                // the backend's Referer-fallback fetch before giving up.
                onError={() => {
                  // A failing data: URL means the recovered bytes weren't a
                  // renderable image — don't loop, give up.
                  if (heroDataUrl) {
                    setHeroBroken(true);
                    return;
                  }
                  const articleId = a.id;
                  api
                    .fetchImageScaled(a.imageUrl!, a.url, READER_IMAGE_MAX_DIM)
                    .then((buf) => {
                      if (useUi.getState().selectedArticleId !== articleId) return;
                      setHeroDataUrl(imageDataUrl(a.imageUrl!, buf));
                    })
                    .catch(() => {
                      if (useUi.getState().selectedArticleId !== articleId) return;
                      setHeroBroken(true);
                    });
                }}
              />
            )
          )}

          {a.enclosures
            .filter((e) => e.mimeType?.startsWith("audio"))
            .map((e, i) => {
              const isPlaying = playingSrc === e.url;
              return (
                <button
                  className={`episode ${isPlaying ? "playing" : ""}`}
                  key={`a${i}`}
                  onClick={() =>
                    playTrack({
                      articleId: a.id,
                      title: a.title,
                      feedTitle: a.feedTitle,
                      src: e.url,
                    })
                  }
                >
                  <span className="episode-play">
                    <Icon name={isPlaying ? "pause" : "play"} size={15} />
                  </span>
                  <span className="episode-text">
                    {isPlaying
                      ? t("reader.episodePlaying")
                      : t("reader.episodePlay")}
                  </span>
                </button>
              );
            })}
          {a.enclosures
            .filter((e) => e.mimeType?.startsWith("video"))
            .map((e, i) => (
              <div className="enclosure" key={`v${i}`}>
                <video controls src={e.url} />
              </div>
            ))}

          {showToggle && (
            <div className="tr-toggle" role="group" aria-label={t("reader.tbTranslate")}>
              <button
                className={!showTranslation ? "on" : ""}
                aria-pressed={!showTranslation}
                onClick={() => setShowTranslation(false)}
              >
                {t("reader.original")}
              </button>
              <button
                className={showTranslation ? "on" : ""}
                aria-pressed={showTranslation}
                onClick={() => setShowTranslation(true)}
              >
                {t("reader.translation")}
              </button>
              {/* Temporary per-article switchers — change engine or language for
                  this translation only, without touching the configured defaults;
                  switching re-translates with the new choice straight away. */}
              <select
                className="s-select tr-sel"
                value={engine}
                aria-label={t("reader.translateEngine")}
                onChange={(e) => {
                  setTmpEngine(e.target.value);
                  run(targetLang, e.target.value);
                }}
              >
                <option value="llm">{t("reader.translateEngineLlm")}</option>
                <option value="google">Google</option>
                <option value="deepl">DeepL</option>
                <option value="bing">Bing</option>
              </select>
              <select
                className="s-select tr-sel"
                value={targetLang}
                aria-label={t("reader.translateTitle")}
                onChange={(e) => {
                  setTmpLang(e.target.value);
                  run(e.target.value, engine);
                }}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              {translating && (
                <span className="tr-progress">
                  {t("reader.translating")}
                  {jobForTarget && jobForTarget.total > 0 &&
                    ` ${jobForTarget.done}/${jobForTarget.total}`}
                </span>
              )}
            </div>
          )}

          <div
            className="article-body"
            ref={bodyRef}
            onClick={handleBodyClick}
            dangerouslySetInnerHTML={bodyHtml}
          />
        </article>
      </div>
      )}

      {lightbox && (
        <Lightbox
          srcs={lightbox.srcs}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}

      {tagPick && (
        <TagPicker
          articleId={a.id}
          attached={a.tags.map((tg) => tg.id)}
          x={tagPick.x}
          y={tagPick.y}
          onClose={() => setTagPick(null)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            ...(ctxMenu.selection
              ? [
                  {
                    icon: "copy" as const,
                    label: t("reader.ctxCopy"),
                    onClick: () => copyText(ctxMenu.selection!, "reader.textCopied"),
                  },
                ]
              : []),
            ...(ctxMenu.imageUrl
              ? [
                  {
                    icon: "arrow-down" as const,
                    label: t("reader.ctxSaveImage"),
                    onClick: () => saveImage(ctxMenu.imageUrl!),
                  },
                  {
                    icon: "copy" as const,
                    label: t("reader.ctxCopyImageAddress"),
                    onClick: () =>
                      copyText(ctxMenu.imageUrl!, "reader.imageAddressCopied"),
                  },
                ]
              : []),
            ...(ctxMenu.selection || ctxMenu.imageUrl
              ? [{ separator: true as const }]
              : []),
            {
              icon: "sparkle",
              label: t("reader.tbAiSummary"),
              onClick: () => useUi.getState().requestAiSummary(),
            },
            ...(canTranslate
              ? [
                  {
                    icon: "globe",
                    label: showTranslation
                      ? t("reader.tbShowOriginal")
                      : t("reader.tbTranslate"),
                    onClick: () =>
                      showTranslation
                        ? setShowTranslation(false)
                        : run(targetLang, engine),
                  },
                ]
              : []),
            { separator: true },
            ...(a.url
              ? [{ icon: "copy", label: t("reader.tbCopyLink"), onClick: copyLink }]
              : []),
            { separator: true },
            {
              icon: focusMode ? "eye-off" : "focus",
              label: t("reader.tbFocusMode"),
              onClick: () => setFocusMode(!focusMode),
            },
          ] as MenuEntry[]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

/** Gate on article length/language: too short (or too thinly Chinese), and no
 *  section renders at all — so the model call it invites never happens. A
 *  wrapper rather than an early return inside the section: the section's hooks
 *  must run unconditionally, and its body can still arrive after mount
 *  (extracted content is fetched lazily), which would otherwise change the
 *  hook count between renders of one instance. Rule lives in
 *  `summaryTooShort` (src/lib/summaryGate.ts) so it's unit-testable. */
function AISummary({ article }: { article: ArticleDetail }) {
  const body = article.extractedHtml || article.contentHtml || "";
  // Memoised on the body — this re-runs whenever the reader re-renders (a
  // toolbar toggle, a store update), and parsing the HTML each time is waste.
  const tooShort = useMemo(() => summaryTooShort(bodyPlainText(body)), [body]);
  if (tooShort) return null;
  return <AISummarySection article={article} />;
}

/** AI summary — a section inline at the top of the article content rather than
 *  an overlay: it reads as part of the article. Nothing is generated until the
 *  user asks for it (the button below, or the I shortcut / command palette /
 *  reader context menu, which all bump the store's request counter) — opening
 *  an article must not silently spend a model call. A finished summary is
 *  persisted by the backend, so revisiting an article shows the stored text
 *  without calling the model again. */
function AISummarySection({ article }: { article: ArticleDetail }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // Initialised from the article's stored summary (if any). The parent keys
  // the article by id, so a switch remounts this component and re-runs this
  // initialiser — no separate "reset on article change" effect is needed.
  const [text, setText] = useState<string | null>(article.aiSummary);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The failure detail, shown in the section itself rather than only in the
  // transient toast — a user who has scrolled on still sees why it failed.
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Identifies the latest generate run. Only the run whose generation still
  // matches may clear `busy` on settle — otherwise a stale run's `finally`
  // would either wedge the section on the loading state or clobber a newer
  // run's `busy` flag.
  const runRef = useRef(0);
  const rootRef = useRef<HTMLElement>(null);

  const generate = useCallback(() => {
    if (busy) return;
    const run = ++runRef.current;
    // An error raised inside the stream surfaces twice: once as an `error`
    // channel event (carrying the precise provider message) and again as the
    // command's rejected promise. Toast only the first so the user does not
    // see the same failure reported twice; the `.catch` still toasts for
    // failures that abort before streaming starts (no key, bad config) and so
    // never emit an `error` event.
    let sawErrorEvent = false;
    // A re-generation keeps the previous summary on screen until the new one
    // starts streaming, so the section never blanks out mid-run (and the
    // header button keeps its "regenerate" label throughout).
    let started = false;
    setBusy(true);
    setFailed(false);
    setErrorMsg(null);
    api
      .aiSummarize(article.id, (ev) => {
        if (ev.type === "delta") {
          if (!started) {
            started = true;
            setText("");
          }
          setText((s) => (s ?? "") + ev.data);
        } else if (ev.type === "error") {
          sawErrorEvent = true;
          setFailed(true);
          // `errorText` localizes the coded failure (no key set, network, …)
          // and passes a provider's own message through verbatim.
          const msg = errorText(ev.data);
          setErrorMsg(msg);
          toast.error(msg);
        }
      })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["article", article.id] });
      })
      .catch((e) => {
        if (!sawErrorEvent) {
          setFailed(true);
          // A failure before streaming starts (no key, bad config) never emits
          // an `error` event, so this is the only place it surfaces.
          const msg = errorText(e);
          setErrorMsg(msg);
          reportError(e);
        }
      })
      .finally(() => {
        if (runRef.current === run) setBusy(false);
      });
  }, [article.id, busy, qc]);

  // External "generate a summary" requests — the I shortcut, the command
  // palette, the reader's context menu. The counter is store-global while this
  // component remounts per article, so compare against the value seen at
  // mount: otherwise merely opening a new article would re-fire a request made
  // for the previous one.
  const request = useUi((s) => s.aiSummaryRequest);
  const seenRequest = useRef(request);
  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    if (busy) return;
    if (text) {
      // A summary is already on screen — bring the section back into view.
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      generate();
    }
  }, [request, busy, text, generate]);

  // The section's single action, in the header: generate when nothing has been
  // produced yet, regenerate once a summary exists, retry after a failure.
  // Filled while there is nothing to show (so it reads as the thing to click),
  // quiet once a summary is on screen.
  const actionLabel = failed
    ? t("common.retry")
    : text
      ? t("reader.aiRegenerate")
      : t("reader.aiGenerate");
  // Parse + sanitize the summary only when the text changes, not on every
  // re-render of the section.
  const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);
  // The injected-HTML prop object itself, memoised — same React 19
  // identity-diff as `bodyHtml` above; an inline literal would re-set the
  // summary's innerHTML on every render.
  const proseHtml = useMemo(() => ({ __html: html }), [html]);

  // The secondary line under the card — never inside it, so neither the
  // pre-generation prompt nor the provenance reads as part of the summary
  // itself. A summary from a build that recorded no provenance (or a provider
  // that reported no usage) falls back to the plain disclaimer rather than
  // showing a half-empty line. While a run is in flight the footer carries the
  // in-progress notice instead (rendered as JSX below).
  let foot = "";
  if (text && !failed) {
    const parts: string[] = [];
    if (article.aiSummaryModel)
      parts.push(t("reader.aiBy", { model: article.aiSummaryModel }));
    if (article.aiSummaryMs != null)
      parts.push(
        t("reader.aiTook", { seconds: (article.aiSummaryMs / 1000).toFixed(1) }),
      );
    if (article.aiSummaryTokens != null)
      parts.push(
        t("reader.aiTokens", { count: article.aiSummaryTokens.toLocaleString() }),
      );
    foot =
      parts.length > 0
        ? `${parts.join(" · ")} · ${t("reader.aiReferenceOnly")}`
        : t("reader.aiDisclaimer");
  } else if (!failed && !text) {
    foot = t("reader.aiIdleHint");
  }

  // Before the first summary exists the body holds nothing (the in-progress
  // notice lives in the footer), so the header's divider would hang over blank
  // space — drop it, and the body's padding, until there is something to show.
  const bodyEmpty = !text && !failed;

  return (
    <div className="ai-summary-wrap">
      <section
        className={`ai-summary ${bodyEmpty ? "is-empty" : ""}`}
        ref={rootRef}
        aria-label={t("reader.aiSummaryTitle")}
      >
        <div className="ai-head">
          <span className="accent-ico">
            <Icon name="sparkle-fill" size={15} />
          </span>
          <h3>{t("reader.aiSummaryTitle")}</h3>
          <button
            className={`ai-action ${text ? "quiet" : ""}`}
            onClick={generate}
            disabled={busy}
          >
            <Icon name={text || failed ? "refresh" : "sparkle"} size={12} />
            {actionLabel}
          </button>
        </div>
        <div className="ai-body" aria-live="polite" aria-busy={busy}>
          {failed && !busy && (
            <div className="ai-error">
              <Icon name="alert" size={16} />
              <span>{errorMsg || t("reader.aiError")}</span>
            </div>
          )}
          {text && !failed && (
            <div
              className="ai-prose"
              onClick={makeLinkClickHandler(article.url)}
              dangerouslySetInnerHTML={proseHtml}
            />
          )}
        </div>
      </section>
      {(busy || foot) && (
        <div className="ai-foot">
          {busy ? (
            <span className="ai-foot-status">
              <span className="ai-dot" />
              <span className="ai-dot" />
              <span className="ai-dot" />
              {t("reader.aiReadingFullText")}
            </span>
          ) : (
            foot
          )}
        </div>
      )}
    </div>
  );
}
