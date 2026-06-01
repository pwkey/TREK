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
    // [460-fork] retry removed (was retry: 2). The two tests that flaked
    // under parallel load — FILE-021 and PROFILE-015 — are upload-refusal
    // tests: the server closes the socket rejecting the upload before multer
    // reads the body, so the client intermittently saw ECONNRESET instead of
    // the HTTP status. Fixed at source: tests/helpers/uploadRefused.ts treats
    // status-or-reset as "refused" (still fails if the upload is ACCEPTED),
    // and PROFILE-015 now uses vi.stubEnv for DEMO_MODE so it can't leak
    // across forked workers. With the real cause fixed, blanket retry is gone
    // — a genuine future flake will surface instead of being silently masked.
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