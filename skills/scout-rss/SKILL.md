---
name: scout-rss
description: >-
  Read, search and triage the user's Scout RSS subscriptions from the shell via
  the `scout` CLI. Use when the user wants to catch up on their feeds, find or
  summarize articles they've subscribed to, check what's unread, star/save
  articles, subscribe to a new feed, or pull new posts. Triggers on: "what's in
  my feeds", "any unread RSS", "summarize this feed", "search my subscriptions
  for X", "mark these read", "subscribe to <url>", "refresh my feeds".
---

# Scout RSS CLI

`scout` is a token-efficient, agent-facing CLI over the user's local Scout RSS
database. It emits [TOON](https://toonformat.dev) on stdout (≈40% cheaper than
JSON, via the official `toon-format` encoder), keeps diagnostics on stderr, and
returns structured errors with exit codes (0 success/no-op, 1 runtime, 2 usage). Reads are token-minimal by default;
long article bodies are truncated with a `--full` escape hatch.

Run `scout` with no arguments first — it prints the unread dashboard plus the
most useful next commands, so you can orient without reading a manual.

## Core flow

```sh
scout                        # home: unread/starred counts + recent unread + next steps
scout feeds                  # subscriptions grouped by folder, with unread counts
scout list --feed <id>       # articles in a feed (defaults to unread; --all for read too)
scout list --starred         # smart views: --starred / --later / --tag <id> / --folder <id>
scout list --fields author,url   # add columns: author,url,snippet,type,feed_id,published
scout read <id> [<id>...]    # plain-text body, truncated; pass several ids to batch
scout read --feed <id> --unread --limit 5   # read a feed's latest unread in one call
scout read <id> --full       # the complete body when truncation hid something
scout search "<query>"       # FTS5 full-text search across every article
```

## Triage & subscriptions

```sh
scout mark read <id> [<id>...]      # state: read|unread|star|unstar|later|unlater (idempotent)
scout mark-all --feed <id>          # mark a whole view read
scout subscribe <url>               # auto-discovers the feed, inserts it, fetches it
scout refresh [--feed <id>]         # fetch new articles over the network
scout extract <id>                  # fetch & store the cleaned full text of an article
```

## Management (mirrors the desktop app)

```sh
scout tags | scout tag add <tag_id> <article_id> | scout tag create "<name>"
scout folders | scout folder create "<name>" | scout feed move <id> --folder <id>
scout opml import <file> | scout opml export
scout settings get <key> | scout settings set <key> <value>
scout stats
```

There are no summarize/ask/digest/translate commands: you are the language
model, so read the text with `scout read <id>` (or gather candidates with
`scout search`) and summarize, answer or translate it yourself — no second AI
provider is involved.

Destructive verbs require `--yes`; without it they fail with exit 2 and tell you
the exact command to re-run:

```sh
scout unsubscribe <id> --yes            # delete a feed and its articles
scout admin cleanup <days> --yes        # also: admin vacuum / admin reset
scout folder delete <id> --yes          # likewise tag delete
```

## Notes

- Every command takes `--db <path>` (or the `SCOUT_DB` env var) if the database
  is not in the desktop app's default location.
- Output is data, not prose. Each list states a definitive total
  (`count: N of M unread`) so you never need to paginate just to learn the size.
- If the answer is "nothing", the command says so explicitly — a zero is an
  answer, not a reason to retry with different flags.
- Prefer the ambient SessionStart hook (`scout setup`) so the unread dashboard is
  already in context at the start of a conversation; this skill is the
  lower-overhead alternative that loads only when a feed task comes up.
