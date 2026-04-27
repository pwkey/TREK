// [460-fork] Milestone 5 — minimal vitest setup for client-side unit tests.
// Loads fake-indexeddb up front so localDb / mutationQueue tests can use
// a real-ish IndexedDB without a browser. Node environment, not jsdom —
// our tests target storage logic, not DOM.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
