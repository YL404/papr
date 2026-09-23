import { describe, it, expect } from "vitest";
import { dueMarks, LIST_MARK_DELAY_MS, type PendingMark } from "./scrollRead";

describe("dueMarks", () => {
  const mark = (id: number, dueAt: number): PendingMark => ({ id, dueAt });

  it("returns only marks whose delay has elapsed", () => {
    const pending = new Map<number, PendingMark>([
      [1, mark(1, 1000)],
      [2, mark(2, 2000)],
    ]);
    expect(dueMarks(pending, 999)).toEqual([]);
    expect(dueMarks(pending, 1000).map((m) => m.id)).toEqual([1]);
    expect(dueMarks(pending, 2000).map((m) => m.id)).toEqual([1, 2]);
  });

  it("does not mutate the pending map", () => {
    const pending = new Map<number, PendingMark>([[1, mark(1, 1000)]]);
    dueMarks(pending, 5000);
    expect(pending.size).toBe(1);
  });

  it("ships a positive delay", () => {
    expect(LIST_MARK_DELAY_MS).toBeGreaterThan(0);
  });
});
