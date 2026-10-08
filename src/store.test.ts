// The `wide` reading-column toggle must survive a relaunch. The store is
// imported fresh per case (module registry reset) to simulate one, with the
// Tauri backend and i18n stubbed out — the store touches neither beyond a
// fire-and-forget settings mirror.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./api", () => ({
  setSetting: vi.fn(() => Promise.resolve()),
  getSetting: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("./i18n", () => ({ default: { t: (key: string) => key } }));

function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

let store: Storage;

beforeEach(() => {
  store = fakeLocalStorage();
  vi.stubGlobal("localStorage", store);
  vi.resetModules();
});

/** A freshly imported store — the module re-evaluates against the current
 *  localStorage stub, i.e. the state a relaunch would boot with. */
const freshStore = async () => (await import("./store")).useUi;

describe("wide mode persistence", () => {
  it("defaults to off on a fresh install", async () => {
    const useUi = await freshStore();
    expect(useUi.getState().wide).toBe(false);
  });

  it("remembers the toggle across a relaunch", async () => {
    const useUi = await freshStore();
    useUi.getState().setWide(true);
    expect(store.getItem("wide")).toBe("1");

    const relaunched = await freshStore();
    expect(relaunched.getState().wide).toBe(true);
  });

  it("remembers turning it back off", async () => {
    const useUi = await freshStore();
    useUi.getState().setWide(true);
    useUi.getState().setWide(false);

    const relaunched = await freshStore();
    expect(relaunched.getState().wide).toBe(false);
  });
});

// Same persistence contract as `wide`, except the blank-line collapse ships
// on by default — the toggle exists to give the original spacing back.
describe("blank-line collapse persistence", () => {
  it("defaults to on", async () => {
    const useUi = await freshStore();
    expect(useUi.getState().collapseBlanks).toBe(true);
  });

  it("remembers turning it off across a relaunch", async () => {
    const useUi = await freshStore();
    useUi.getState().setCollapseBlanks(false);
    expect(store.getItem("collapseBlanks")).toBe("0");

    const relaunched = await freshStore();
    expect(relaunched.getState().collapseBlanks).toBe(false);
  });
});

// A refresh is driven entirely by the backend's `refresh-progress` stream, and
// the sidebar renders straight off this state — so the accounting (and the idle
// tick that must *not* light the UI) is worth pinning down.
describe("refresh progress", () => {
  const started = (total: number) => ({ event: "started", data: { total } }) as const;
  const feedStart = (feedId: number) => ({ event: "feedStart", data: { feedId } }) as const;
  const feedDone = (feedId: number, error: string | null = null) =>
    ({ event: "feedDone", data: { feedId, newArticles: 0, error } }) as const;
  const finished = { event: "finished", data: { newArticles: 0 } } as const;

  it("tracks in-flight sources and the done count", async () => {
    const useUi = await freshStore();
    useUi.getState().applyRefreshEvent(started(3));
    expect(useUi.getState().refresh).toEqual({
      total: 3,
      done: 0,
      inFlight: [],
      failed: 0,
    });

    useUi.getState().applyRefreshEvent(feedStart(7));
    useUi.getState().applyRefreshEvent(feedStart(9));
    expect(useUi.getState().refresh?.inFlight).toEqual([7, 9]);

    useUi.getState().applyRefreshEvent(feedDone(7));
    expect(useUi.getState().refresh).toMatchObject({ done: 1, inFlight: [9] });

    useUi.getState().applyRefreshEvent(finished);
    expect(useUi.getState().refresh).toBeNull();
  });

  it("counts sources that failed", async () => {
    const useUi = await freshStore();
    useUi.getState().applyRefreshEvent(started(2));
    useUi.getState().applyRefreshEvent(feedDone(1, "boom"));
    useUi.getState().applyRefreshEvent(feedDone(2));
    expect(useUi.getState().refresh).toMatchObject({ done: 2, failed: 1 });
  });

  it("ignores an idle scheduler tick", async () => {
    // The backend bows out of a `Due` run with nothing due without reporting
    // (refresh.rs), so this pair should never arrive — but a `started` with
    // no sources must never light the UI regardless, so the store stays
    // defensive.
    const useUi = await freshStore();
    useUi.getState().applyRefreshEvent(started(0));
    expect(useUi.getState().refresh).toBeNull();
  });

  it("ignores per-source events that arrive with no run", async () => {
    const useUi = await freshStore();
    useUi.getState().applyRefreshEvent(feedStart(1));
    useUi.getState().applyRefreshEvent(feedDone(1));
    expect(useUi.getState().refresh).toBeNull();
  });
});
