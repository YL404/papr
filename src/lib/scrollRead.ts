// Helpers for the article list's "mark read when scrolled out of the list"
// behaviour (see ArticleList).

/** How long a row must stay out of the viewport before it is marked read —
 *  long enough to scroll back and cancel, short enough to feel immediate. */
export const LIST_MARK_DELAY_MS = 1000;

/** A row that left the viewport and is waiting out its mark-read delay. */
export interface PendingMark {
  id: number;
  dueAt: number;
}

/** Entries of `pending` whose mark-read delay has elapsed by `now`.
 *  Does not mutate `pending` — the caller drops what it acts on. */
export function dueMarks(
  pending: ReadonlyMap<number, PendingMark>,
  now: number,
): PendingMark[] {
  const due: PendingMark[] = [];
  for (const m of pending.values()) if (m.dueAt <= now) due.push(m);
  return due;
}
