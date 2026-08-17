// vitest.config.ts
//
// vitest is the test runner for `cmms-api/dashboard-v2/` (the Vue 3 SPA).
// The rest of `cmms-api/` uses `bun:test` for plain TS unit tests, but
// for Vue SFC components vitest + happy-dom + @vitejs/plugin-vue is the
// well-trodden path. Trying to use bun:test for SFCs fights bun's
// broken built-in .vue loader and happy-dom's missing hasOwnProperty
// polyfill — not worth the fight.
//
// To run: `cd cmms-api/dashboard-v2 && bun run test:vue`
//   (or `bunx vitest run` for one-shot, `bunx vitest` for watch mode)
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})
