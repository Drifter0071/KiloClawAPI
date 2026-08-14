// tests/app-shell-mobile-drawer.spec.ts
//
// Regression test for the mobile rail drawer behaviour.
//
// Bug fixed (commit a9471e3 → 8d2f1c1):
//   <ConversationRail @click="closeRail" /> was wired on AppShell so that
//   ANY bubbled click inside the rail — including the search input —
//   closed the drawer. After the fix, the drawer should close ONLY on:
//     1. The scrim click (the area behind the panel)
//     2. The Escape key
//     3. A route change triggered by a nav button or thread pick
//   But NOT on:
//     - Tapping the search field
//     - Tapping an empty area inside the rail panel itself
//     - Typing in the search field
//
// This test mounts AppShell, simulates a mobile viewport, opens the
// rail, and asserts the drawer stays open through the bad taps and
// closes only on the good ones.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AppShell from '../src/shell/AppShell.vue'
import ConversationRail from '../src/shell/ConversationRail.vue'
import ResponsiveDrawer from '../src/components/ResponsiveDrawer.vue'
import AppTopbar from '../src/shell/AppTopbar.vue'
import GlobalBanner from '../src/shell/GlobalBanner.vue'

// ---------------------------------------------------------------------------
// Mobile viewport stub
// ---------------------------------------------------------------------------

let originalMatchMedia: typeof window.matchMedia | undefined
let mobileMatches = true

function stubMatchMedia() {
  originalMatchMedia = window.matchMedia
  // @ts-expect-error — minimal stub for happy-dom
  window.matchMedia = (query: string) => ({
    matches: mobileMatches, // pretend we're on a 375px-wide screen
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
// Router harness — AppShell listens to route changes; we need a real router
// but never actually navigate to a real page in these tests. We use a
// single stub `/ask` route so the rail's `router.push('/ask')` resolves.
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
  // Stub fetch so the onMounted probe inside the rail doesn't crash
  // (useApi().getTokens() runs in AppTopbar / ConnectionStatus etc.).
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, tokens: [] }),
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
      // Stub the heavy children — AppShell is just a layout, we want to
      // exercise only the rail drawer + nav-button interactions.
      components: { ConversationRail, ResponsiveDrawer, AppTopbar, GlobalBanner },
    },
    attachTo: document.body,
  })
}

async function flush() {
  // Wait for onMounted to run and the responsive ref to settle.
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
  await nextTick()
}

async function openRail() {
  // Click the hamburger button in the topbar (visible only on mobile).
  const toggle = document.body.querySelector('[data-testid="topbar-rail-toggle"]') as HTMLElement
  expect(toggle).toBeTruthy()
  toggle.click()
  await nextTick()
  await nextTick()
  // After open, the panel + scrim should be in the DOM.
  expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeTruthy()
  expect(document.body.querySelector('[data-testid="drawer-backdrop"]')).toBeTruthy()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppShell — mobile rail drawer', () => {
  it('opens the drawer when the hamburger is tapped', async () => {
    wrapper = mountShell()
    await flush()
    await openRail()
    // Drawer is still open
    expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeTruthy()
  })

  it('does NOT close the drawer when the search field is tapped', async () => {
    wrapper = mountShell()
    await flush()
    await openRail()
    const input = document.body.querySelector(
      '[data-testid="rail-thread-filter"]',
    ) as HTMLInputElement
    expect(input).toBeTruthy()
    input.focus()
    input.click()
    await nextTick()
    // Drawer should still be open
    expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="drawer-backdrop"]')).toBeTruthy()
  })

  it('does NOT close the drawer when the user types in the search field', async () => {
    wrapper = mountShell()
    await flush()
    await openRail()
    const input = document.body.querySelector(
      '[data-testid="rail-thread-filter"]',
    ) as HTMLInputElement
    expect(input).toBeTruthy()
    input.focus()
    // Simulate typing — the input event also bubbles a click on most
    // browsers when the user taps the field again, so we explicitly
    // fire both 'input' and 'click' to be safe.
    input.value = 'szerviz'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeTruthy()
    expect(input.value).toBe('szerviz') // value preserved
  })

  it('does NOT close the drawer when the user taps an empty area inside the rail panel', async () => {
    wrapper = mountShell()
    await flush()
    await openRail()
    const panel = document.body.querySelector('[data-testid="responsive-drawer"]') as HTMLElement
    expect(panel).toBeTruthy()
    // Click on the rail itself (not a button, not the scrim). The rail
    // root has data-testid="conversation-rail".
    const rail = document.body.querySelector('[data-testid="conversation-rail"]') as HTMLElement
    expect(rail).toBeTruthy()
    // Dispatch a click directly on the rail root — this represents the
    // user tapping a non-interactive part of the panel.
    rail.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeTruthy()
  })

  it('DOES close the drawer when the scrim is tapped', async () => {
    wrapper = mountShell()
    await flush()
    await openRail()
    const scrim = document.body.querySelector('[data-testid="drawer-backdrop"]') as HTMLElement
    expect(scrim).toBeTruthy()
    scrim.click()
    await nextTick()
    // After scrim close, both the panel and the scrim should be gone
    expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="drawer-backdrop"]')).toBeNull()
  })

  it('DOES close the drawer when a nav button is tapped (route change)', async () => {
    wrapper = mountShell()
    await flush()
    await openRail()
    const navMap = document.body.querySelector(
      '[data-testid="rail-nav-map"]',
    ) as HTMLButtonElement
    expect(navMap).toBeTruthy()
    navMap.click()
    // Wait for: (1) router.push, (2) the watcher to fire, (3) the
    // ResponsiveDrawer's v-if="open" to unmount. flushPromises drains
    // microtasks; nextTick drains the next Vue render cycle.
    for (let i = 0; i < 5; i++) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 0))
    }
    // Drawer is closed after navigation
    expect(document.body.querySelector('[data-testid="responsive-drawer"]')).toBeNull()
  })
})
