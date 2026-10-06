//! Headless feed refresh — the UI-free core of a refresh cycle.
//!
//! Selects the sources to touch, fetches them with bounded concurrency, ingests
//! new articles, and runs retention cleanup. Progress is reported through an
//! `on_event` callback so callers can render it however they like.
//!
//! The desktop app wraps [`refresh_core`] with the Tauri plumbing (a
//! `refresh-progress` event, notifications, tray updates — see
//! `papr_lib::scheduler`); the agent CLI drives it directly, forwarding events
//! to stderr.

use crate::db;
use crate::error::AppResult;
use crate::ingestion::{fetch, parse};
use crate::models::{RefreshProgress, SourceType};
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::task::JoinSet;

/// Outcome of a [`refresh_core`] run.
#[derive(Clone, Copy, Debug)]
pub struct RefreshSummary {
    /// Number of newly inserted articles across all sources.
    pub new_articles: usize,
    /// `false` only when a `Due`-scoped run found nothing due and skipped the
    /// pipeline entirely. Lets the desktop scheduler keep idle ticks genuinely
    /// idle (no notifications / tray refresh on an empty cycle).
    pub ran: bool,
}

/// Which feeds a refresh run should touch.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RefreshScope {
    /// Every feed — the manual refresh and OPML import.
    All,
    /// Only sources whose per-feed (or global) interval has elapsed — the
    /// background scheduler. An empty due-set skips the whole pipeline.
    Due,
    /// A single feed by id — the per-feed
    /// manual refresh (`refresh --feed <id>`). Always runs the pipeline.
    Feed(i64),
    /// Every feed in one folder by id — the per-folder manual refresh. Always
    /// runs the pipeline.
    Folder(i64),
}

/// Insert a batch of articles for one feed in bounded chunks, releasing the
/// shared DB lock between each so concurrent queries aren't starved while a
/// large feed (hundreds of items) is being ingested. Returns the count newly
/// inserted; `label` only distinguishes the warning text.
async fn upsert_articles(
    db: &Mutex<Connection>,
    feed_id: i64,
    articles: &[db::NewArticle],
    dedup: bool,
    label: &str,
) -> usize {
    let mut new_count = 0usize;
    for chunk in articles.chunks(64) {
        let conn = db.lock().await;
        for article in chunk {
            match db::upsert_article(&conn, feed_id, article, dedup) {
                Ok(true) => new_count += 1,
                Ok(false) => {}
                Err(e) => log::warn!("{label} upsert failed (feed {feed_id}): {e}"),
            }
        }
    }
    new_count
}

/// Outcome of fetching one feed.
enum Outcome {
    NotModified,
    Updated {
        parsed: parse::ParsedFeed,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    Failed(String),
}

async fn fetch_one(
    client: &reqwest::Client,
    url: &str,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Outcome {
    match fetch::conditional_get(client, url, etag.as_deref(), last_modified.as_deref()).await {
        Ok(fetch::Fetched::NotModified) => Outcome::NotModified,
        Ok(fetch::Fetched::Body {
            bytes,
            etag,
            last_modified,
        }) => match parse::parse_feed(&bytes, url) {
            Ok(parsed) => Outcome::Updated {
                parsed,
                etag,
                last_modified,
            },
            Err(e) => Outcome::Failed(e.to_string()),
        },
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// Refresh the sources selected by `scope`: fetch with bounded concurrency,
/// ingest new articles, and run retention cleanup. Reports progress through
/// `on_event` and returns the new-article count.
///
/// UI-free and side-effect-light: it performs no cross-process locking (callers
/// serialize) and no desktop notifications. `db` is the writer connection
/// behind an async mutex; `client` is a shared HTTP client (cheap to clone per
/// feed).
pub async fn refresh_core(
    db: &Mutex<Connection>,
    client: &reqwest::Client,
    scope: RefreshScope,
    mut on_event: impl FnMut(RefreshProgress),
) -> AppResult<RefreshSummary> {
    let (feeds, concurrency, dedup) = {
        let conn = db.lock().await;
        // The global default interval for feeds without a per-feed override.
        let global_min = db::get_setting(&conn, "refresh_interval_min")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|m| *m >= 5)
            .map(|m| m.min(db::REFRESH_OFF_MINUTES))
            .unwrap_or(30);
        let feeds = match scope {
            RefreshScope::All => db::feeds_to_refresh(&conn)?,
            RefreshScope::Due => db::feeds_due_for_refresh(&conn, global_min)?,
            RefreshScope::Feed(id) => db::feeds_to_refresh_for_feed(&conn, id)?,
            RefreshScope::Folder(id) => db::feeds_to_refresh_in_folder(&conn, id)?,
        };
        let concurrency =
            db::setting_parsed::<i64>(&conn, "net_concurrency", 6).clamp(1, 16) as usize;
        let dedup = db::setting_flag(&conn, "dedup_enabled", false);
        (feeds, concurrency, dedup)
    };

    // Nothing due this cycle: bow out before the heavier tail without reporting
    // — the scheduler fires this path every tick, and a no-op event pair would
    // make every event consumer guard against an empty run. The manual refresh
    // (scope All) always runs the pipeline.
    if scope == RefreshScope::Due && feeds.is_empty() {
        return Ok(RefreshSummary {
            new_articles: 0,
            ran: false,
        });
    }

    on_event(RefreshProgress::Started { total: feeds.len() });

    let sem = Arc::new(Semaphore::new(concurrency));
    // `on_event` is a plain `FnMut` and cannot be moved into the spawned tasks,
    // so a task hands its start over this channel and the main loop drains it
    // below — enough to keep the per-source event order the UI needs.
    let (starts_tx, mut starts_rx) = mpsc::unbounded_channel();
    // The feed URL travels back out alongside the outcome — `refine_source_type`
    // needs it for the Mastodon `/@user.rss` pattern check below.
    let mut set: JoinSet<(i64, String, Outcome)> = JoinSet::new();
    for (id, url, etag, last_modified) in feeds {
        let client = client.clone();
        let sem = sem.clone();
        let starts_tx = starts_tx.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            // Only once the permit is held is this source really being fetched:
            // every task is spawned up front, so reporting earlier would light
            // up the whole list at once instead of a few rows at a time.
            let _ = starts_tx.send(RefreshProgress::FeedStart { feed_id: id });
            let outcome = fetch_one(&client, &url, etag, last_modified).await;
            (id, url, outcome)
        });
    }

    let mut total_new = 0usize;
    while let Some(joined) = set.join_next().await {
        let Ok((feed_id, feed_url, outcome)) = joined else {
            continue;
        };
        let mut new_here = 0usize;
        let mut error: Option<String> = None;

        match outcome {
            Outcome::NotModified => {
                let conn = db.lock().await;
                let _ = db::touch_feed(&conn, feed_id);
            }
            Outcome::Failed(e) => {
                let conn = db.lock().await;
                let _ = db::set_feed_error(&conn, feed_id, &e);
                error = Some(e);
            }
            Outcome::Updated {
                parsed,
                etag,
                last_modified,
            } => {
                new_here +=
                    upsert_articles(db, feed_id, &parsed.articles, dedup, "rss").await;
                let conn = db.lock().await;
                let _ = db::update_feed_meta(
                    &conn,
                    feed_id,
                    parsed.title.as_deref(),
                    parsed.site_url.as_deref(),
                    parsed.description.as_deref(),
                    parsed.icon.as_deref(),
                );
                let _ = db::set_feed_fetch_state(
                    &conn,
                    feed_id,
                    etag.as_deref(),
                    last_modified.as_deref(),
                    None,
                );
                // Promote a still-generic `'rss'` feed to its real kind now that
                // the parsed document reveals it (audio enclosures → podcast,
                // `/@user.rss` → mastodon). A no-op for an already classified feed.
                let refined = parse::refine_source_type(SourceType::Rss, &parsed, &feed_url);
                let _ = db::refine_feed_source_type(&conn, feed_id, refined);
            }
        }

        // Drain queued starts *before* this source's done goes out. A task
        // sends its start before fetching, so each start is either still
        // queued here or was already drained on an earlier iteration — either
        // way it precedes the done, which is the order the UI's in-flight
        // accounting relies on.
        while let Ok(started) = starts_rx.try_recv() {
            on_event(started);
        }

        total_new += new_here;
        on_event(RefreshProgress::FeedDone {
            feed_id,
            new_articles: new_here,
            error,
        });
    }

    // Retention: drop old read articles when a finite window is configured. The
    // DELETE scans the whole table, so throttle it to once per day rather than
    // running on every refresh cycle.
    {
        let conn = db.lock().await;
        let retention = db::get_setting(&conn, "retention_days").ok().flatten();
        if let Some(days) = retention.and_then(|v| v.parse::<i64>().ok()) {
            let now = chrono::Utc::now().timestamp();
            let last_run = db::setting_parsed::<i64>(&conn, "retention_last_run", 0);
            if now - last_run >= 86_400 {
                match db::cleanup_old_articles(&conn, days) {
                    Ok(removed) => {
                        if removed > 0 {
                            log::info!("retention: removed {removed} old articles");
                        }
                        let _ = db::set_setting(&conn, "retention_last_run", &now.to_string());
                    }
                    Err(e) => log::warn!("retention cleanup failed: {e}"),
                }
            }
        }
    }

    on_event(RefreshProgress::Finished {
        new_articles: total_new,
    });
    Ok(RefreshSummary {
        new_articles: total_new,
        ran: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serve `body` to every request on a loopback port and return the base
    /// URL — enough HTTP for `fetch_one` in a test, no mock-server dependency.
    fn serve(body: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, head.as_bytes());
                let _ = std::io::Write::write_all(&mut stream, body);
            }
        });
        format!("http://{addr}/feed.xml")
    }

    const RSS: &[u8] = br#"<?xml version="1.0"?>
        <rss version="2.0"><channel><title>Test</title>
          <item><title>One</title></item>
          <item><title>Two</title></item>
        </channel></rss>"#;

    /// A source's `FeedStart` must precede its own `FeedDone`: the UI marks a
    /// row in-flight on the start and clears it on the done, so an inverted
    /// pair would leave the row spinning for the rest of the run.
    #[tokio::test]
    async fn feed_start_precedes_its_feed_done() {
        let base = serve(RSS);
        let conn = crate::db::tests::test_conn();
        let id_a =
            db::insert_feed(&conn, &format!("{base}a.xml"), None, "A", None, SourceType::Rss, None)
                .unwrap();
        let id_b =
            db::insert_feed(&conn, &format!("{base}b.xml"), None, "B", None, SourceType::Rss, None)
                .unwrap();
        let db = Mutex::new(conn);

        let events: Arc<std::sync::Mutex<Vec<RefreshProgress>>> = Arc::default();
        let sink = events.clone();
        let summary = refresh_core(&db, &reqwest::Client::new(), RefreshScope::All, move |e| {
            sink.lock().unwrap().push(e);
        })
        .await
        .unwrap();
        assert_eq!(summary.new_articles, 4);

        let ev = events.lock().unwrap();
        assert!(matches!(ev.first(), Some(RefreshProgress::Started { total: 2 })));
        assert!(matches!(ev.last(), Some(RefreshProgress::Finished { .. })));
        for id in [id_a, id_b] {
            let start = ev
                .iter()
                .position(|e| matches!(e, RefreshProgress::FeedStart { feed_id } if *feed_id == id))
                .unwrap_or_else(|| panic!("no FeedStart for feed {id}"));
            let done = ev
                .iter()
                .position(|e| matches!(e, RefreshProgress::FeedDone { feed_id, .. } if *feed_id == id))
                .unwrap_or_else(|| panic!("no FeedDone for feed {id}"));
            assert!(start < done, "FeedStart({id}) must precede FeedDone({id})");
        }
    }
}
