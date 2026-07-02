import { defineConfig } from 'vitest/config';

/**
 * Server integration tests share ONE Postgres database and the single demo
 * tenant. Running the ~80 test files in parallel forks races on that shared
 * state — concurrent writers exhaust connections and perturb tenant-wide
 * operations (e.g. the retro allocation run), which surfaced as a
 * non-deterministic "victim" test failing each run. The suite is fully green
 * run sequentially, so file-level parallelism is disabled here. Tests within a
 * file still run in order as normal; only cross-file parallelism is turned off.
 *
 * (The domain package has no DB and keeps default parallelism via its own run.)
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
