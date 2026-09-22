import { defineConfig } from "vitest/config";

// Vitest covers the dependency-free, pure logic modules: the browser-extension
// feed detection (feature F6) and the highlight re-anchoring algorithm
// (feature F7, `src/lib/anchor.ts`), plus the UI store's persistence contract
// (its Tauri / i18n imports are stubbed in the test). All run in a plain node
// environment — React component files are deliberately excluded; they would
// need a DOM.
export default defineConfig({
  test: {
    include: [
      "extension/test/**/*.test.{js,ts}",
      "src/lib/**/*.test.ts",
      "src/store.test.ts",
    ],
    environment: "node",
  },
});
