import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/dist/**",
      // Cloud Workers live outside this checkout; run these from the cloud package.
      "**/embeddings.cloud.test.js",
    ],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
    // Tests that touch the DB layer (db-concurrent, db-sqlite-vs-lowdb, any
    // route whose mock misses) would otherwise open the developer's live
    // ~/.switchboard/db/data.sqlite and write real usage rows into it.
    env: { DATA_DIR: resolve(__dirname, ".tmp-data") },
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
