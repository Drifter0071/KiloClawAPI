// tests/sorszam-link.spec.ts
//
// Tests for the SorszamLink in-message sorszam detector + the Ask
// page's ticket panel layout shift on click.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { nextTick } from 'vue'
import SorszamLink from '../src/components/SorszamLink.vue'
import AskPage from '../src/routes/AskPage.vue'
import { useAskStore } from '../src/stores/ask'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { answerMock, pushMock } = vi.hoisted(() => ({
  answerMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ answer: answerMock }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

// ---------------------------------------------------------------------------
// SorszamLink — pure unit tests
// ---------------------------------------------------------------------------

describe('SorszamLink', () => {
  it('renders plain text when no sorszam is present', () => {
    const wrapper = mount(SorszamLink, { props: { text: 'hello world' } })
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).toBe('hello world')
  })

  it('detects a B-sorszam and renders it as a clickable link', async () => {
    const wrapper = mount(SorszamLink, {
      props: { text: 'See ticket B26071801 for details' },
    })
    const links = wrapper.findAll('button')
    expect(links).toHaveLength(1)
    expect(links[0]!.text()).toBe('B26071801')
    expect(links[0]!.attributes('data-testid')).toBe('sorszam-link-B26071801')
    expect(links[0]!.attributes('data-sorszam-prefix')).toBe('B')

    await links[0]!.trigger('click')
    expect(wrapper.emitted('sorszamClick')?.[0]).toEqual([
      { prefix: 'B', sorszam: 'B26071801' },
    ])
  })

  it('detects an M-device id with a hyphen (M-26057)', async () => {
    const wrapper = mount(SorszamLink, {
      props: { text: 'A gép M-26057 vezérlése' },
    })
    const links = wrapper.findAll('button')
    expect(links).toHaveLength(1)
    expect(links[0]!.text()).toBe('M-26057')
    expect(links[0]!.attributes('data-sorszam-prefix')).toBe('M')

    await links[0]!.trigger('click')
    // The emitted sorszam strips the hyphen to match the wire shape;
    // prefix='M' tells callers this is a machine, not a job.
    expect(wrapper.emitted('sorszamClick')?.[0]).toEqual([
      { prefix: 'M', sorszam: 'M26057' },
    ])
  })

  it('detects multiple sorszams in the same text', () => {
    const wrapper = mount(SorszamLink, {
      props: { text: 'compare B26071801 against M26057' },
    })
    const links = wrapper.findAll('button')
    expect(links).toHaveLength(2)
    expect(links.map((b) => b.text())).toEqual(['B26071801', 'M26057'])
  })

  it('does not match a bare word that looks vaguely numeric', () => {
    const wrapper = mount(SorszamLink, {
      props: { text: '1234567 nem ticket' },
    })
    expect(wrapper.findAll('button')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AskPage — sorszam-click flow (split layout)
// ---------------------------------------------------------------------------

describe('AskPage sorszam-click flow', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    setActivePinia(createPinia())
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    answerMock.mockReset()
    pushMock.mockReset()
  })

  function mountPage() {
    return mount(AskPage, {
      global: {
        plugins: [
          createPinia(),
          [VueQueryPlugin, { queryClient }],
        ],
      },
    })
  }

  it('clicking a sorszam in a user message opens the right-side panel and shifts the conversation', async () => {
    // Seed a chat history with a user message that contains a sorszam.
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    store.push({
      role: 'user',
      text: 'Mi a helyzet a B26071801 ticket-tel?',
      ts: Date.now(),
    })

    const wrapper = mount(AskPage, {
      global: {
        plugins: [pinia, [VueQueryPlugin, { queryClient }]],
      },
    })

    // No ticket panel before the click.
    expect(wrapper.find('[data-testid="ticket-panel"]').exists()).toBe(false)

    // Click the sorszam.
    const link = wrapper.get('[data-testid="sorszam-link-B26071801"]')
    await link.trigger('click')
    await nextTick()

    // The panel is now in the DOM with the right sorszam.
    const panel = wrapper.get('[data-testid="ticket-panel"]')
    expect(panel.get('[data-testid="ticket-panel-sorszam"]').text()).toBe('B26071801')

    // The conversation wrapper uses the flex layout (md:flex-row)
    // when the panel is open.
    const conversationWrapper = wrapper.get('[data-testid="ask-conversation-wrapper"]')
    const cls = conversationWrapper.attributes('class') ?? ''
    expect(cls).toContain('md:flex-row')
  })

  it('clicking an M-prefix device id routes to /ask with a device query (no panel)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    store.push({
      role: 'user',
      text: 'M26057 vezérlése?',
      ts: Date.now(),
    })

    const wrapper = mount(AskPage, {
      global: {
        plugins: [pinia, [VueQueryPlugin, { queryClient }]],
      },
    })

    pushMock.mockClear()
    const link = wrapper.get('[data-testid="sorszam-link-M26057"]')
    await link.trigger('click')
    await nextTick()

    // M-prefix → setSeedQ (router.push) to /ask with the bare sorszam.
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/ask',
        state: expect.objectContaining({ seedQ: 'M26057' }),
      }),
    )
    // No panel opens for M-IDs.
    expect(wrapper.find('[data-testid="ticket-panel"]').exists()).toBe(false)
  })

  it('the panel stays closed when no sorszam has been clicked', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    store.push({ role: 'user', text: 'Nincs ticket itt', ts: Date.now() })

    const wrapper = mount(AskPage, {
      global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
    })

    expect(wrapper.find('[data-testid="ticket-panel"]').exists()).toBe(false)
    // The conversation wrapper uses the block layout (no split).
    const cls = wrapper
      .get('[data-testid="ask-conversation-wrapper"]')
      .attributes('class') ?? ''
    expect(cls).toContain('block')
    expect(cls).not.toContain('md:flex-row')
  })

  it('the input clears after submitting a question', async () => {
    const wrapper = mountPage()

    // Type and submit a question.
    const input = wrapper.get('[data-testid="ask-bar-input"]')
    await input.setValue('M26057')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    // The input value is back to empty.
    const inputEl = wrapper.get<HTMLInputElement>('[data-testid="ask-bar-input"]')
    expect(inputEl.element.value).toBe('')
  })
})
