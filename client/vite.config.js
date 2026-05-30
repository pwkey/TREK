import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // [460-fork] Inject the service-worker registration script into the
      // HTML head — without this, dev mode serves the SW file but never
      // registers it, so Chrome's installability check silently fails.
      injectRegister: 'script',
      // [460-fork] Enable the manifest + service worker in `npm run dev` so
      // Chrome / Edge offer the install prompt during phone testing through
      // a tunnel. Without this, vite-plugin-pwa only wires up for production
      // builds and Chrome's PWA-detection silently passes on the install UI.
      devOptions: { enabled: true, type: 'module' },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/uploads/, /^\/mcp/],
        // [460-fork] Activate new SW immediately on next page load instead
        // of waiting for every tab to close. Without these the PWA on
        // Android can get stuck on a stale build for an indefinite time
        // because Chrome keeps the SW alive in the background.
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // Carto map tiles (default provider)
            urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenStreetMap tiles (fallback / alternative)
            urlPattern: /^https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Leaflet CSS/JS from unpkg CDN
            urlPattern: /^https:\/\/unpkg\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-libs',
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // API calls — prefer network, fall back to cache
            // Exclude sensitive endpoints (auth, admin, backup, settings)
            urlPattern: /\/api\/(?!auth|admin|backup|settings).*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-data',
              expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Uploaded files (photos, covers — public assets only)
            urlPattern: /\/uploads\/(?:covers|avatars)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'user-uploads',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: {
        name: '460 Trip Planner',
        short_name: '460',
        description: 'Trip planning and recording for our 460 travel group.',
        theme_color: '#8b3a1a',
        background_color: '#3d1a08',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'any',
        categories: ['travel', 'navigation'],
        icons: [
          { src: 'icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // [460-fork] Maskable icon points to a SEPARATE source designed for
          // Android adaptive icons — content inside the inner 80% safe zone,
          // background filling to the edges. Previously this entry reused the
          // regular icon-512x512.png, which has 460-text near the bottom edge;
          // Android couldn't form a valid adaptive icon from it and fell back
          // to grey on the home screen.
          { src: 'icons/icon-512x512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  build: {
    sourcemap: false,
  },
  server: {
    port: 5173,
    // [460-fork] Allow any host so dev tunnels (ngrok / Cloudflare /
    // Tailscale) can serve the app for phone testing without having to
    // patch this list each time. This only affects the dev server;
    // production builds are static files served by the backend.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:3001',
        ws: true,
      },
      '/mcp': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
