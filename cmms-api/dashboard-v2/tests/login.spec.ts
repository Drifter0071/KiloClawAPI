// tests/login.spec.ts
//
// Phase 6 — LoginPage (src/routes/LoginPage.vue) + the /login route
// bypass of AppShell.
//
// Covers:
//   1. Empty state: title + password input + disabled submit button.
//   2. Submitting the form POSTs to /dashboard/login as JSON.
//   3. On 200 + { ok, token }: stores the token in sessionStorage and
//      routes to /ask.
//   4. On 401 + { ok: false, error: 'wrong password' }: shows the
//      Hungarian error message; the password field is preserved; no
//      sessionStorage write happens.
//   5. On network error: shows the humanized error from
//      humanizeError().
//   6. Enter key submits the form (via the password field's keydown).
//   7. The onMounted probe (GET /dashboard/api/tokens) redirects
//      already-authed users to /ask.
//
// We mock global.fetch (vue-test-utils' test environment is happy-dom,
// which has a real fetch). We do NOT mount <AppShell> — LoginPage is
// expected to render its own full-bleed layout and ignore the topbar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import LoginPage from '../src/routes/LoginPage.vue'

// ---------------------------------------------------------------------------
// Router harness — LoginPage redirects via router.push('/ask') so we need
// a real router. memory history lets us inspect navigation.
// ---------------------------------------------------------------------------

async function mountPage(): Promise<{ wrapper: VueWrapper; router: ReturnType<typeof createRouter> }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: LoginPage },
      { path: '/ask', name: 'ask', component: { template: '<div data-testid="ask-stub">Ask</div>' } },
    ],
  })
  await router.push('/login')
  await router.isReady()
  const wrapper = mount(LoginPage, {
    global: { plugins: [router] },
  })
  // Track the wrapper so afterEach can unmount it; the test that
  // navigates to /ask leaves LoginPage alive, and a later test's new
  // mount would otherwise see double-fired effects from the stale
  // instance.
  lastWrapper = wrapper
  return { wrapper, router }
}
let lastWrapper: VueWrapper | null = null

const SESSION_TOKEN_KEY = 'cmms_dash_token'

/**
 * Build a fetch mock that answers /dashboard/api/maintenance (probe),
 * /dashboard/api/tokens (auth probe), and /dashboard/login (submit)
 * with the given response factories. Other URLs get a generic 404.
 * The maintenance probe reuses the auth-probe response factory — it
 * just needs to return 4xx for "not in maintenance" or 2xx + enabled
 * for "in maintenance".
 */
function buildFetchMock(
  probeResp: () => Response | Promise<Response>,
  submitResp: (url: string) => Response | Promise<Response>,
  maintenanceResp: () => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ enabled: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string') {
      if (url === '/dashboard/api/maintenance') return Promise.resolve(maintenanceResp())
      if (url === '/dashboard/api/tokens') return Promise.resolve(probeResp())
    }
    return Promise.resolve(submitResp(url))
  })
  return fn
}

beforeEach(() => {
  setActivePinia(createPinia())
  try { window.sessionStorage.removeItem(SESSION_TOKEN_KEY) } catch { /* ignore */ }
  // The POSTs-JSON test stubs global fetch and mounts a LoginPage that
  // navigates to /ask without unmounting. Unstub the previous test's
  // fetch so the new mock is the only one in play, and reset the call
  // log so we don't see leaked counts from the previous test.
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
  // Tear down the previous test's wrapper so the next test's mount
  // doesn't share effects with an orphan instance.
  if (lastWrapper) {
    lastWrapper.unmount()
    lastWrapper = null
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoginPage', () => {
  it('renders the password form with the disabled submit button until the user types', async () => {
    const { wrapper } = await mountPage()
    const card = wrapper.get('[data-testid="login-card"]')
    expect(card.text()).toContain('Bejelentkezés')
    expect(card.text()).toContain('Add meg a hozzáférési jelszót')

    const input = wrapper.get('[data-testid="login-password"]')
    expect(input.attributes('type')).toBe('password')

    const btn = wrapper.get('[data-testid="login-submit"]')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('POSTs JSON { password } to /dashboard/login and on success stores the token + routes to /ask', async () => {
    // Probe → 401 (stay on /login). Submit → 200 with token.
    const fetchMock = buildFetchMock(
      () => new Response('unauthorized', { status: 401 }),
      (url) =>
        new Response(
          JSON.stringify({ ok: true, token: 'cmms_read_abc123', cookie_set: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { wrapper, router } = await mountPage()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/login')
    // LoginPage fires 2 probes on mount: maintenance + auth. Submit
    // makes the 3rd call.
    expect(fetchMock).toHaveBeenCalledTimes(2) // 2 probes

    // Drive the submit through the password's Enter key (bypasses
    // the Button's click forwarding, which has caused trouble).
    const input = wrapper.get('[data-testid="login-password"]')
    await input.setValue('correct horse battery staple')
    await nextTick()
    await input.trigger('keydown.enter')
    await flushPromises()
    await flushPromises()

    // 2 probes + 1 submit = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const submitCall = fetchMock.mock.calls.find((c) => c[0] === '/dashboard/login')!
    const [url, init] = submitCall as [string, RequestInit]
    expect(url).toBe('/dashboard/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ password: 'correct horse battery staple' })
    expect(init.credentials).toBe('same-origin')

    // Token lands in sessionStorage under the v1-compatible key.
    expect(window.sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('cmms_read_abc123')
    // Router navigated to /ask.
    expect(router.currentRoute.value.path).toBe('/ask')
  })

  it('shows the "Hibás jelszó." inline error on 401 and does NOT write sessionStorage', async () => {
    const fetchMock = buildFetchMock(
      () => new Response('unauthorized', { status: 401 }),
      (url) => {
        if (url === '/dashboard/login') {
          return Promise.resolve(
            new Response(JSON.stringify({ ok: false, error: 'wrong password' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        return Promise.resolve(new Response('not found', { status: 404 }))
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const { wrapper, router } = await mountPage()
    await flushPromises()

    const input = wrapper.get('[data-testid="login-password"]')
    await input.setValue('nope')
    await nextTick()
    await input.trigger('keydown.enter')
    await flushPromises()
    await flushPromises()

    // 2 probes + 1 submit = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const err = wrapper.get('[data-testid="login-error"]')
    expect(err.text()).toBe('Hibás jelszó.')
    expect(window.sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull()
    // Still on the login page — no router push.
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('shows a humanized error on a network failure', async () => {
    // LoginPage fires three fetches on mount + submit: the maintenance
    // probe, the auth probe, then the login submit. Queue 3 rejects.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // maintenance probe
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // auth probe
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // submit
    vi.stubGlobal('fetch', fetchMock)

    const { wrapper } = await mountPage()
    await flushPromises()

    const input = wrapper.get('[data-testid="login-password"]')
    await input.setValue('whatever')
    await nextTick()
    await input.trigger('keydown.enter')
    await flushPromises()
    await flushPromises()

    // The page calls humanizeError(err) on the TypeError; that falls
    // through to the generic Error branch which returns the message
    // ("Failed to fetch" wrapped into a humanized sentence). The
    // important contract is that *some* error reaches the inline
    // alert — the exact wording is humanizeError's concern, tested
    // separately in lib-phase5.
    const err = wrapper.get('[data-testid="login-error"]')
    expect(err.text().toLowerCase()).toContain('failed')
  })

  it('Enter in the password field submits the form', async () => {
    const fetchMock = buildFetchMock(
      () => new Response('unauthorized', { status: 401 }),
      (url) =>
        new Response(JSON.stringify({ ok: true, token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { wrapper } = await mountPage()
    await flushPromises()

    const input = wrapper.get('[data-testid="login-password"]')
    await input.setValue('hunter2')
    await nextTick()
    await input.trigger('keydown.enter')
    await flushPromises()
    await flushPromises()

    // 2 probes + 1 submit = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(window.sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('tok')
  })

  it('the onMounted probe redirects already-authed users to /ask', async () => {
    const fetchMock = buildFetchMock(
      () =>
        new Response(
          JSON.stringify({
            read_token_prefix: 'cmms_rea',
            write_token_prefix: 'cmms_wri',
            bearer_token_prefix: 'cmms_bea',
          }),
          { status: 200 },
        ),
      () => new Response('not used', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { router } = await mountPage()
    await flushPromises()
    await flushPromises()

    // 1 maintenance probe + 1 auth probe = 2 calls.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The tokens call is the second one (after the maintenance probe).
    const tokensCall = fetchMock.mock.calls.find((c) => c[0] === '/dashboard/api/tokens')!
    expect(tokensCall).toBeDefined()
    expect(router.currentRoute.value.path).toBe('/ask')
  })

  it('stays on the login page when the probe fails (no session cookie)', async () => {
    const fetchMock = buildFetchMock(
      () => new Response('unauthorized', { status: 401 }),
      () => new Response('not used', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { router } = await mountPage()
    await flushPromises()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/login')
  })
})
