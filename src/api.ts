// Thin typed wrappers over the Tauri command surface (src-tauri/src/commands.rs).

import { invoke, Channel } from "@tauri-apps/api/core";
import { imageBytes, type ImageBytesResponse } from "./lib/imageBytes";
import type {
  AiEvent,
  ArticleDetail,
  ArticlePreviewTranslation,
  ArticleQuery,
  ArticleSummary,
  DiscoveryResult,
  Feed,
  Folder,
  RefreshProgress,
  SmartCounts,
  Tag,
  TranslateEvent,
} from "./types";

// ── folders ──
export const listFolders = () => invoke<Folder[]>("list_folders");
export const createFolder = (name: string) =>
  invoke<number>("create_folder", { name });
export const renameFolder = (id: number, name: string) =>
  invoke<void>("rename_folder", { id, name });
export const deleteFolder = (id: number) =>
  invoke<void>("delete_folder", { id });

// ── images ──
/** Fetch an image's raw bytes via the backend, which walks Referer fallbacks
 *  (none → image origin → article URL) until the host serves it — hotlink
 *  protection demands different Referers on different hosts. Used by the
 *  reader's "Save image" action and to retry images the webview itself failed
 *  to load. `pageUrl` is the embedding article's link. */
export const fetchImage = (url: string, pageUrl?: string | null) =>
  invoke<ImageBytesResponse>("fetch_image", { url, pageUrl: pageUrl ?? null }).then(
    imageBytes,
  );

// ── feeds ──
export const listFeeds = () => invoke<Feed[]>("list_feeds");
export const addFeed = (url: string, folderId: number | null) =>
  invoke<Feed>("add_feed", { url, folderId });
/**
 * Discover feeds matching a query — curated directory + live page scrape.
 * `lang` is the UI language; the curated directory is scoped to it so the
 * recommendations are in a language the user reads.
 */
export const searchFeedDirectory = (query: string, lang: string) =>
  invoke<DiscoveryResult[]>("search_feed_directory", { query, lang });
export const deleteFeed = (id: number) => invoke<void>("delete_feed", { id });
export const moveFeed = (id: number, folderId: number | null) =>
  invoke<void>("move_feed", { id, folderId });
export const renameFeed = (id: number, title: string) =>
  invoke<void>("rename_feed", { id, title });
/** Set a feed's refresh interval (minutes). `null` follows the global
 *  setting; `525600` opts the feed out of automatic refresh. */
export const setFeedRefreshInterval = (id: number, minutes: number | null) =>
  invoke<void>("set_feed_refresh_interval", { id, minutes });
/** Toggle a feed's auto-translate flag. When on, opening an article from the
 *  feed translates it into the configured target language straight away. */
export const setFeedAutoTranslate = (id: number, enabled: boolean) =>
  invoke<void>("set_feed_auto_translate", { id, enabled });
/** Set a feed's per-feed open mode. `null` reverts to the default behaviour
 *  (reader view, honouring the global auto-extract preference). */
export const setFeedOpenMode = (
  id: number,
  mode: "reader" | "extracted" | "web" | null,
) => invoke<void>("set_feed_open_mode", { id, mode });

/** Refresh feeds, reporting progress through the supplied callback. With no
 *  `scope` this refreshes every feed; pass `{ feedId }` for a single feed or
 *  `{ folderId }` for every feed in one folder. */
export function refreshFeeds(
  onProgress?: (p: RefreshProgress) => void,
  scope?: { feedId?: number; folderId?: number },
): Promise<number> {
  const channel = new Channel<RefreshProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<number>("refresh_feeds", {
    onProgress: channel,
    feedId: scope?.feedId ?? null,
    folderId: scope?.folderId ?? null,
  });
}

// ── articles ──
export const listArticles = (
  query: ArticleQuery,
  unreadOnly: boolean,
  search: string | null,
  oldestFirst: boolean,
  limit: number,
  offset: number,
) =>
  invoke<ArticleSummary[]>("list_articles", {
    query,
    unreadOnly,
    search,
    oldestFirst,
    limit,
    offset,
  });

/** 0-based position of `articleId` in the list these filters produce, or null
 *  when it isn't in that list (filtered out / different feed). Drives paging the
 *  middle pane down to an article opened from search. */
export const articleIndex = (
  query: ArticleQuery,
  unreadOnly: boolean,
  oldestFirst: boolean,
  articleId: number,
) =>
  invoke<number | null>("article_index", {
    query,
    unreadOnly,
    oldestFirst,
    articleId,
  });

export const getArticle = (id: number) =>
  invoke<ArticleDetail>("get_article", { id });
export const markRead = (id: number, read: boolean) =>
  invoke<void>("mark_read", { id, read });
export const markStarred = (id: number, starred: boolean) =>
  invoke<void>("mark_starred", { id, starred });
export const markReadLater = (id: number, value: boolean) =>
  invoke<void>("mark_read_later", { id, value });
export const markAllRead = (query: ArticleQuery) =>
  invoke<number>("mark_all_read", { query });
export const smartCounts = () => invoke<SmartCounts>("smart_counts");

// ── full-text extraction ──
export const extractFulltext = (articleId: number) =>
  invoke<string>("extract_fulltext", { articleId });

// ── OPML ──
export const importOpml = (content: string) =>
  invoke<number>("import_opml", { content });
export const exportOpml = () => invoke<string>("export_opml");

// ── AI (streaming over a Channel) ──
export function aiSummarize(
  articleId: number,
  onToken: (e: AiEvent) => void,
): Promise<void> {
  const channel = new Channel<AiEvent>();
  channel.onmessage = onToken;
  return invoke<void>("ai_summarize", { articleId, onToken: channel });
}

/** Translate the article body into `lang` using `engine` (`llm` / `google` /
 *  `deepl` / `bing`). Progress is reported per batch over `onEvent` (start →
 *  batch* → done); the full result is also persisted and returned via the final
 *  `done` event. */
export function aiTranslate(
  articleId: number,
  lang: string,
  engine: string,
  onEvent: (e: TranslateEvent) => void,
): Promise<void> {
  const channel = new Channel<TranslateEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("ai_translate", { articleId, lang, engine, onEvent: channel });
}

/** Translate only the list preview fields for an article and persist them in the
 *  preview cache. */
export const translateArticlePreview = (articleId: number, lang: string, engine: string) =>
  invoke<ArticlePreviewTranslation>("translate_article_preview", { articleId, lang, engine });

/** The built-in translation prompt template, shown in Settings → AI as the
 *  current effective prompt when the user has not customized it (and restored
 *  by the "restore default" action). */
export const defaultTranslatePrompt = () =>
  invoke<string>("default_translate_prompt");

/** The selectable built-in AI-summary prompt templates (id + text), so Settings
 *  can list them and preview each one's prompt. */
export const summaryPresets = () =>
  invoke<{ id: string; template: string }[]>("summary_presets");

// ── settings ──
export const getSetting = (key: string) =>
  invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) =>
  invoke<void>("set_setting", { key, value });

// ── storage ──
export interface StorageStats {
  dbBytes: number;
  articleCount: number;
  feedCount: number;
}
export const storageStats = () => invoke<StorageStats>("storage_stats");
export const cleanupArticles = (days: number) =>
  invoke<number>("cleanup_articles", { days });
export const vacuumDb = () => invoke<void>("vacuum_db");
export const resetSettings = () => invoke<void>("reset_settings");
export const clearAllData = () => invoke<void>("clear_all_data");

// ── network ──
export const applyNetworkSettings = () =>
  invoke<void>("apply_network_settings");

// ── tray ──
export const refreshTray = () => invoke<void>("refresh_tray");

// ── tags ──
export const listTags = () => invoke<Tag[]>("list_tags");
export const createTag = (name: string) =>
  invoke<number>("create_tag", { name });
export const renameTag = (id: number, name: string) =>
  invoke<void>("rename_tag", { id, name });
export const setTagColor = (id: number, color: string) =>
  invoke<void>("set_tag_color", { id, color });
export const deleteTag = (id: number) => invoke<void>("delete_tag", { id });
export const reorderTags = (ids: number[]) =>
  invoke<void>("reorder_tags", { ids });
export const setArticleTag = (articleId: number, tagId: number, on: boolean) =>
  invoke<void>("set_article_tag", { articleId, tagId, on });

// ── in-app original-page view (issue #49) ──
// A native child webview overlaid on the reading area. Bounds are logical
// (CSS) pixels relative to the window content top-left — i.e. what
// getBoundingClientRect returns inside the main webview.
export interface PageViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const openPageView = (url: string, b: PageViewBounds) =>
  invoke<void>("open_page_view", { url, ...b });
export const setPageViewBounds = (b: PageViewBounds) =>
  invoke<void>("set_page_view_bounds", { ...b });
export const setPageViewVisible = (visible: boolean) =>
  invoke<void>("set_page_view_visible", { visible });
export const closePageView = () => invoke<void>("close_page_view");
