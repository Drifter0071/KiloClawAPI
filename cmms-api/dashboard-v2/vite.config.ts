import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Multi-page Vite build. The dashboard project has two separate
// HTML entries that produce two separate SPAs served at different
// URL prefixes:
//
//   1. index.html → /dashboard/v2/         (operator SPA, base = /dashboard/v2/)
//   2. admin.html → /dashboard/admin/      (admin SPA, base = /dashboard/admin/)
//
// They share Vite chunking, design tokens, and shared components,
// but they are TWO INDEPENDENT Vue apps at runtime — each boots its
// own Vue instance, Pinia, router, and VueQuery client. The admin
// SPA has NO AppShell, no operator topbar, no operator sidebar, no
// bottom tabs. The two never share runtime state.
//
// To put admin in the same Vite app, both index.html and admin.html
// must be declared as rollupOptions.input entries, and each must set
// its own <base href="..."> tag (see admin.html).

export default defineConfig({
  // Use RELATIVE asset URLs (./assets/...) so each HTML entry's own
  // <base href="..."> tag resolves them correctly. The alternative
  // — absolute /assets/... — hardcodes the URL prefix and only
  // works for one of the two SPAs. With relative URLs:
  //   dist/index.html  has <base href="/dashboard/v2/">  and
  //                     <script src="./assets/main-XXX.js">
  //                     → resolves to /dashboard/v2/assets/main-XXX.js ✓
  //   dist/admin.html  has <base href="/dashboard/admin/"> and
  //                     <script src="./assets/admin-XXX.js">
  //                     → resolves to /dashboard/admin/assets/admin-XXX.js ✓
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/dashboard/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: false,
        cookieDomainRewrite: 'localhost',
      },
      '/dashboard/login': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2020',
    minify: 'esbuild',
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
      output: {
        manualChunks: {
          cytoscape: ['cytoscape', 'cytoscape-cose-bilkent'],
        },
      },
    },
  },
})
