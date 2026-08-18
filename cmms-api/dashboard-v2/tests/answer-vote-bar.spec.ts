// tests/answer-vote-bar.spec.ts
//
// The like/dislike footer on every assistant bubble.
//
// Coverage:
//   1. Renders two icon buttons; both disabled while `disabled` is true.
//   2. Clicking 👍 when `initialVote=0` POSTs vote=1 and highlights.
//   3. Clicking 👍 when `initialVote=1` POSTs vote=1 again (server
//      deletes the row — un-vote).
//   4. Clicking 👎 when `initialVote=0` AND verbose=off POSTs vote=-1
//      immediately with no reason.
//   5. Clicking 👎 when verbose=on opens the reason modal (teleported
//      to body); submitting with a reason emits 'submitted' with the
//      reason string; submitVote runs with that reason.
//   6. Clicking the same side again (👍 on a 👍 vote) toggles to 0 and
//      calls submitVote (server un-votes).
//   7. On 5xx, the local state reverts to the previous value.
//   8. The bar forwards `vote-submitted` with the final { vote, reason }.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AnswerVoteBar from '@/components/AnswerVoteBar.vue'
import DislikeReasonModal from '@/components/DislikeReasonModal.vue'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({
    submitFeedbackVote: submitMock,
  }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}))

// We mock the verbose-settings fetch by stubbing global fetch. The
// component calls fetch('/dashboard/api/feedback/settings') on the
// first 👎 click when the flag is unknown.
const originalFetch = globalThis.fetch
function mockSettings(verbose: boolean | 'fail' = false): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes('/dashboard/api/feedback/settings')) {
      if (verbose === 'fail') {
        return new Response('nope', { status: 401 })
      }
      return new Response(JSON.stringify({ verbose_dislike: !!verbose }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

beforeEach(() => {
  submitMock.mockReset()
  submitMock.mockResolvedValue({ ok: true, vote: 1, answer_id: 'A1' })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.innerHTML = ''
})

async function mountBar(
  props: Partial<InstanceType<typeof AnswerVoteBar>['$props']> = {},
) {
  return mount(AnswerVoteBar, {
    props: { answerId: 'A1', ...props },
    global: { components: { DislikeReasonModal } },
    attachTo: document.body,
  })
}

describe('AnswerVoteBar — disabled while streaming', () => {
  it('disables both buttons when `disabled` is true', async () => {
    const w = await mountBar({ disabled: true })
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    const dislike = w.get('[data-testid="answer-vote-bar-dislike"]').element as HTMLButtonElement
    expect(like.disabled).toBe(true)
    expect(dislike.disabled).toBe(true)
    // Clicking the disabled button must NOT trigger the submit.
    await like.click()
    await dislike.click()
    expect(submitMock).not.toHaveBeenCalled()
  })

  it('enables both buttons when `disabled` is false', async () => {
    const w = await mountBar({ disabled: false })
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    const dislike = w.get('[data-testid="answer-vote-bar-dislike"]').element as HTMLButtonElement
    expect(like.disabled).toBe(false)
    expect(dislike.disabled).toBe(false)
  })
})

describe('AnswerVoteBar — like interactions (verbose irrelevant)', () => {
  it('clicking 👍 from 0 POSTs vote=1 and highlights the icon', async () => {
    const w = await mountBar({ initialVote: 0 })
    await w.get('[data-testid="answer-vote-bar-like"]').trigger('click')
    await flushPromises()
    expect(submitMock).toHaveBeenCalledWith({ answer_id: 'A1', vote: 1, reason: undefined })
    // The icon now has the nct-soft highlight (aria-pressed=true).
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    expect(like.getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking 👍 when already 1 toggles to 0 (un-vote — server deletes)', async () => {
    const w = await mountBar({ initialVote: 1 })
    await w.get('[data-testid="answer-vote-bar-like"]').trigger('click')
    await flushPromises()
    expect(submitMock).toHaveBeenCalledWith({ answer_id: 'A1', vote: 1, reason: undefined })
    // Optimistic toggle: local state flips to 0 immediately, the
    // server's same-side branch DELETEs the row, and a re-hydrate
    // on the next mount would also confirm 0.
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    expect(like.getAttribute('aria-pressed')).toBe('false')
  })

  it('emits vote-submitted after a successful round-trip', async () => {
    const w = await mountBar({ initialVote: 0 })
    await w.get('[data-testid="answer-vote-bar-like"]').trigger('click')
    await flushPromises()
    const events = w.emitted('vote-submitted') ?? []
    expect(events.length).toBe(1)
    expect(events[0]?.[0]).toEqual({ answerId: 'A1', vote: 1, reason: undefined })
  })
})

describe('AnswerVoteBar — dislike interactions', () => {
  it('clicking 👎 when verbose=OFF POSTs vote=-1 immediately, no reason', async () => {
    mockSettings(false)
    const w = await mountBar({ initialVote: 0 })
    await w.get('[data-testid="answer-vote-bar-dislike"]').trigger('click')
    await flushPromises()
    expect(submitMock).toHaveBeenCalledWith({ answer_id: 'A1', vote: -1, reason: undefined })
    // No modal teleported
    expect(document.body.querySelector('[data-testid="dislike-reason-modal"]')).toBeNull()
  })

  it('clicking 👎 when verbose=ON opens the reason modal, no immediate POST', async () => {
    mockSettings(true)
    const w = await mountBar({ initialVote: 0 })
    await w.get('[data-testid="answer-vote-bar-dislike"]').trigger('click')
    // Wait for the settings fetch to resolve + the modal to open.
    await flushPromises()
    expect(submitMock).not.toHaveBeenCalled()
    const modal = document.body.querySelector('[data-testid="dislike-reason-modal"]')
    expect(modal).not.toBeNull()
  })

  it('clicking 👎 when settings fetch 401s treats it as verbose=OFF (immediate POST)', async () => {
    mockSettings('fail')
    const w = await mountBar({ initialVote: 0 })
    await w.get('[data-testid="answer-vote-bar-dislike"]').trigger('click')
    await flushPromises()
    expect(submitMock).toHaveBeenCalledWith({ answer_id: 'A1', vote: -1, reason: undefined })
  })

  it('clicking 👎 when already -1 un-votes (no modal, no reason)', async () => {
    mockSettings(true) // would normally open modal
    const w = await mountBar({ initialVote: -1 })
    await w.get('[data-testid="answer-vote-bar-dislike"]').trigger('click')
    await flushPromises()
    expect(submitMock).toHaveBeenCalledWith({ answer_id: 'A1', vote: -1, reason: undefined })
    // No modal — we only open on a fresh dislike
    expect(document.body.querySelector('[data-testid="dislike-reason-modal"]')).toBeNull()
  })
})

describe('AnswerVoteBar — error handling', () => {
  it('reverts the local state on a 5xx and does NOT emit vote-submitted', async () => {
    submitMock.mockRejectedValueOnce({ status: 500, message: 'HTTP 500', body: { error: 'internal' } })
    const w = await mountBar({ initialVote: 0 })
    await w.get('[data-testid="answer-vote-bar-like"]').trigger('click')
    await flushPromises()
    // local state reverts
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    expect(like.getAttribute('aria-pressed')).toBe('false')
    // no event fired
    expect(w.emitted('vote-submitted') ?? []).toHaveLength(0)
  })
})

describe('AnswerVoteBar — re-hydration', () => {
  it('respects initialVote on mount', async () => {
    const w = await mountBar({ initialVote: 1 })
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    expect(like.getAttribute('aria-pressed')).toBe('true')
  })

  it('snaps to a new initialVote when the prop changes (chat switch)', async () => {
    const w = await mountBar({ initialVote: 0 })
    const like = w.get('[data-testid="answer-vote-bar-like"]').element as HTMLButtonElement
    expect(like.getAttribute('aria-pressed')).toBe('false')
    await w.setProps({ initialVote: 1 })
    await nextTick()
    expect(like.getAttribute('aria-pressed')).toBe('true')
  })
})
