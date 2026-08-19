// tests/app-shell-mobile-drawer.spec.ts
//
// Regression test for mobile shell behaviour.
//
// As of 2026-08-19, the mobile hamburger menu and side drawer have been
// removed — the bottom tab bar (BottomTabs) handles all mobile navigation.
// This test verifies:
//   1. No hamburger button is rendered on mobile
//   2. No ResponsiveDrawer is rendered on mobile
//   3. BottomTabs IS rendered on mobile
//   4. ConversationRail is NOT rendered as a standalone element on mobile
//      (it's only in the desktop sidebar)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AppShell from '../src/shell/AppShell.vue'

// ---------------------------------------------------------------------------
// Mobile viewport stub
// ---------------------------------------------------------------------------

let originalMatchMedia: typeof window.matchMedia | undefined
let mobileMatches = true

function stubMatchMedia() {
  originalMatchMedia = window.matchMedia
  // @ts-expect-error — minimal stub for happy-dom
  window.matchMedia = (query: string) => ({
    matches: mobileMatches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })
}

function restoreMatchMedia() {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia
}

// ---------------------------------------------------------------------------
// Router harness
// ---------------------------------------------------------------------------

async function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/ask' },
      { path: '/ask', name: 'ask', component: { template: '<div data-testid="stub-ask" />' } },
      { path: '/map', name: 'map', component: { template: '<div data-testid="stub-map" />' } },
    ],
  })
  await router.push('/ask')
  await router.isReady()
  return router
}

let wrapper: VueWrapper | null = null
let router: ReturnType<typeof createRouter> | null = null

beforeEach(async () => {
  setActivePinia(createPinia())
  stubMatchMedia()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false }),
      text: async () => '',
    }),
  )
  router = await makeRouter()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  router = null
  restoreMatchMedia()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountShell() {
  return mount(AppShell, {
    global: {
      plugins: [router!],
    },
    attachTo: document.body,
  })
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
  await nextTick()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppShell — mobile layout (no drawer)', () => {
  it('does NOT render a hamburger button on mobile', async () => {
    mobileMatches = true
    wrapper = mountShell()
    await flush()
    const toggle = document.body.querySelector('[data-testid="topbar-rail-toggle"]')
    expect(toggle).toBeNull()
  })

  it('does NOT render a ResponsiveDrawer on mobile', async () => {
    mobileMatches = true
    wrapper = mountShell()
    await flush()
    const drawer = document.body.querySelector('[data-testid="responsive-drawer"]')
    expect(drawer).toBeNull()
  })

  it('renders BottomTabs on mobile', async () => {
    mobileMatches = true
    wrapper = mountShell()
    await flush()
    const tabs = document.body.querySelector('[data-testid="bottom-tabs"]')
    expect(tabs).toBeTruthy()
  })

  it('does NOT render the desktop rail sidebar on mobile', async () => {
    mobileMatches = true
    wrapper = mountShell()
    await flush()
    const rail = document.body.querySelector('[data-testid="app-rail-desktop"]')
    expect(rail).toBeNull()
  })
})
