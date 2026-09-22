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
