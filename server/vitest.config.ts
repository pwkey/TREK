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