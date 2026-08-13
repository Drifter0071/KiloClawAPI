// tests/operator-menu.spec.ts
//
// OperatorMenu.vue — topbar avatar + logout popover.
//
// The previous v1 used a native <form method="POST"> for logout which
// broke under the Vue v-if popover lifecycle (closing `open` removed
// the form before the browser dispatched the POST). v2 calls the
// server's /dashboard/logout endpoint via fetch() and then
// window.location.assign() the login page.
//
// These tests verify the new flow:
//   1. Popover opens on avatar click
//   2. Popover contains a Kijelentkezés button (not a <form> anymore)
//   3. Clicking logout fires a POST to /dashboard/logout with
//      credentials: 'same-origin', then clearSessionToken() runs, then
//      window.location.assign('/dashboard/v2/login') is called
//   4. The button is disabled while logging out (no double-submit)
//   5. Clicking outside the popover closes it (HIG behaviour)
//   6. Escape closes the popover

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import OperatorMenu from '../src/shell/OperatorMenu.vue'

// The composable lives at @/composables/useSessionToken and is the
// real implementation under test (clearSessionToken). No mock
// needed — the side effect we care about is sessionStorage being
// cleared, which the test asserts directly.

const $testid = (id: string) => document.body.querySelector(`[data-testid="${id}"]`)

let wrapper: VueWrapper | null = null
let fetchMock: ReturnType<typeof vi.fn>
let locationAssignMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Default fetch mock: 302 redirect to login. The fetch call uses
  // redirect: 'manual' so the response is an "opaque" type — the
  // actual status code is 0 in JS. We just need fetch to resolve.
  fetchMock = vi.fn().mockResolvedValue({ status: 0, type: 'opaqueredirect' })
  vi.stubGlobal('fetch', fetchMock)
  // Spy on location.assign so the test can assert it was called
  // without triggering a real navigation.
  locationAssignMock = vi.fn()
  // Replace location.assign on the current window. We can't replace
  // the whole `location` object, but `.assign` is replaceable.
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign: locationAssignMock },
    writable: true,
    configurable: true,
  })
  // Clear any leftover sessionStorage from previous tests.
  window.sessionStorage.clear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('OperatorMenu', () => {
  it('popover is closed by default', () => {
    wrapper = mount(OperatorMenu, { attachTo: document.body })
    expect($testid('operator-menu-popover')).toBeNull()
  })

  it('clicking the avatar opens the popover', async () => {
    wrapper = mount(OperatorMenu, { attachTo: document.body })
    await wrapper.get('[data-testid="operator-menu"]').trigger('click')
    await nextTick()
    const popover = $testid('operator-menu-popover') as HTMLElement
    expect(popover).toBeTruthy()
    expect(popover.textContent).toContain('Kijelentkezés')
  })

  it('clicking Kijelentkezés POSTs to /dashboard/logout, clears the token, and navigates to login', async () => {
    // Pre-seed a sessionStorage token so we can confirm it's cleared.
    window.sessionStorage.setItem('cmms_dash_token', 'fake-token-1234')
    expect(window.sessionStorage.getItem('cmms_dash_token')).toBe('fake-token-1234')

    wrapper = mount(OperatorMenu, { attachTo: document.body })
    await wrapper.get('[data-testid="operator-menu"]').trigger('click')
    await nextTick()
    await wrapper.get('[data-testid="operator-menu-logout"]').trigger('click')
    await nextTick()

    // fetch was called with the right shape.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/dashboard/logout')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')

    // sessionStorage token is gone.
    expect(window.sessionStorage.getItem('cmms_dash_token')).toBeNull()

    // window.location.assign('/dashboard/v2/login') was called.
    expect(locationAssignMock).toHaveBeenCalledWith('/dashboard/v2/login')
  })

  it('the logout button is disabled while a logout is in flight', async () => {
    // Make fetch hang so we can observe the in-flight state.
    fetchMock = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    wrapper = mount(OperatorMenu, { attachTo: document.body })
    await wrapper.get('[data-testid="operator-menu"]').trigger('click')
    await nextTick()
    // Capture the button BEFORE clicking it. Note: clicking logout
    // closes the popover (sets `open = false` at the start of logout),
    // but the disabled state should still be reflected on the avatar
    // button itself (which is also disabled while logging out).
    const avatarBtn = wrapper.get('[data-testid="operator-menu"]')
    expect(avatarBtn.attributes('disabled')).toBeUndefined()
    // Click logout (button is inside the popover). The click handler
    // will fire async — we don't await it, just trigger.
    const logoutBtn = wrapper.get('[data-testid="operator-menu-logout"]')
    void logoutBtn.trigger('click')
    // Let the synchronous prefix of logout() run: open = false, then
    // loggingOut = true, then clearSessionToken + fetch (which hangs).
    // The popover is now closed (v-if removed the logout button) but
    // the avatar button is still mounted and should be disabled.
    await nextTick()
    expect(avatarBtn.attributes('disabled')).toBeDefined()
  })

  it('clicking outside the popover closes it', async () => {
    wrapper = mount(OperatorMenu, { attachTo: document.body })
    await wrapper.get('[data-testid="operator-menu"]').trigger('click')
    await nextTick()
    expect($testid('operator-menu-popover')).toBeTruthy()
    // Click on document.body (outside the popover).
    document.body.click()
    await nextTick()
    expect($testid('operator-menu-popover')).toBeNull()
  })

  it('Escape closes the popover', async () => {
    wrapper = mount(OperatorMenu, { attachTo: document.body })
    await wrapper.get('[data-testid="operator-menu"]').trigger('click')
    await nextTick()
    expect($testid('operator-menu-popover')).toBeTruthy()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect($testid('operator-menu-popover')).toBeNull()
  })
})
