import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// [460-fork] fileURLToPath fixes alias resolution on Windows. `new URL(..., import.meta.url).pathname`
// emits `/E:/…` on Windows which Node then can't resolve. Good upstream PR candidate.
const resolveSdk = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    // [460-fork] A couple of upload/demo integration tests (FILE-021,
    // PROFILE-015) are reliable in isolation but flake under full parallel
    // load — they contend on the shared physical uploads/ + data/ dirs and
    // demo-mode state across forked workers. retry re-runs only FAILED tests
    // (green tests pay nothing): a transient contention flake clears on the
    // next attempt, while a genuinely broken test still fails all 3 attempts,
    // so this does not mask real regressions. Proper fix (per-test temp dirs
    // / DEMO_MODE isolation) is logged as a follow-up in docs.
    retry: 2,
    silent: false,
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@modelcontextprotocol/sdk/server/mcp': resolveSdk('./node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js'),
      '@modelcontextprotocol/sdk/server/streamableHttp': resolveSdk('./node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js'),
      '@modelcontextprotocol/sdk/inMemory': resolveSdk('./node_modules/@modelcontextprotocol/sdk/dist/cjs/inMemory.js'),
      '@modelcontextprotocol/sdk/client/index': resolveSdk('./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js'),
    },
  },
});