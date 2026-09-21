// Type mirrors of the Rust domain model (see src-tauri/src/models.rs).

export type SourceType =
  | "rss"
  | "youtube"
  | "podcast"
  | "mastodon"
  | "bluesky"
  | "reddit"
  | "newsletter";

/** A feed-discovery result (mirrors discovery::DiscoveryResult). */
export interface DiscoveryResult {
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  category: string | null;
  description: string | null;
  /** true → curated directory entry, false → live page scrape. */
  fromDirectory: boolean;
}

export interface Folder {
  id: number;
  name: string;
  position: number;
}

export interface Feed {
  id: number;
  feedUrl: string;
  siteUrl: string | null;
  title: string;
  description: string | null;
  faviconUrl: string | null;
  folderId: number | null;
  sourceType: SourceType;
  lastFetchedAt: string | null;
  fetchError: string | null;
  unreadCount: number;
  /** Per-feed refresh interval in minutes. `null` follows the global
   *  setting; the `525600` sentinel means "never". */
  refreshIntervalMin: number | null;
  /** When true, opening an article from this feed auto-translates it into the
   *  configured target language. Defaults to false (show the original). */
  autoTranslate: boolean;
  /** How articles from this feed open: reader view, auto-extracted full text,
   *  or the embedded web view of the original page. `null` follows the default
   *  behaviour (reader view, honouring the global auto-extract preference). */
  openMode: "reader" | "extracted" | "web" | null;
}

export interface Enclosure {
  url: string;
  mimeType: string | null;
  length: number | null;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  position: number;
  articleCount: number;
}

export interface ArticlePreviewTranslation {
  articleId: number;
  title: string;
  snippet: string;
  lang: string;
  engine: string;
}

export interface ArticleSummary {
  id: number;
  feedId: number;
  feedTitle: string;
  sourceType: SourceType;
  title: string;
  author: string | null;
  snippet: string | null;
  imageUrl: string | null;
  url: string | null;
  publishedAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  readLater: boolean;
}

export interface ArticleDetail {
  id: number;
  feedId: number;
  feedTitle: string;
  sourceType: SourceType;
  title: string;
  author: string | null;
  url: string | null;
  contentHtml: string | null;
  extractedHtml: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  readLater: boolean;
  aiSummary: string | null;
  /** Provenance of the stored summary, shown under it in the reader. All
   *  `null` for summaries generated before these were recorded. */
  aiSummaryModel: string | null;
  /** How long the summary took to generate, in milliseconds. */
  aiSummaryMs: number | null;
  /** Total tokens (input + output); `null` when the provider reported none. */
  aiSummaryTokens: number | null;
  /** Cached translated body HTML, if a translation has been generated. */
  translatedHtml: string | null;
  /** The target language code the cached translation was produced for. */
  translatedLang: string | null;
  enclosures: Enclosure[];
  tags: Tag[];
}

export interface SmartCounts {
  unread: number;
  starred: number;
  readLater: number;
}

// Mirrors the adjacently-tagged Rust `ArticleQuery` enum.
export type ArticleQuery =
  | { kind: "all" }
  | { kind: "unread" }
  | { kind: "starred" }
  | { kind: "readLater" }
  | { kind: "feed"; value: number }
  | { kind: "folder"; value: number }
  | { kind: "tag"; value: number };

export type AiEvent =
  | { type: "delta"; data: string }
  | { type: "done" }
  /** Coded failure, shaped like the Rust `AppError` — resolve it with
   *  `errorText()` so the message is localized. */
  | { type: "error"; data: { code: string; detail?: string | null } };

/** Batch-level translation progress (mirrors commands::TranslateEvent). */
export type TranslateEvent =
  | { type: "start"; data: { total: number } }
  | { type: "batch"; data: { html: string; done: number } }
  | { type: "done"; data: { html: string } };

export type RefreshProgress =
  | { event: "started"; data: { total: number } }
  | {
      event: "feedDone";
      data: { feedId: number; newArticles: number; error: string | null };
    }
  | { event: "finished"; data: { newArticles: number } };
