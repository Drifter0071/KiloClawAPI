<script setup lang="ts">
// src/components/AnswerVoteBar.vue
//
// Like / dislike footer for an Ask assistant bubble.
//
// UX:
//   - Two icon buttons, right-aligned, compact.
//   - No count on the user side (intentional — avoid herding).
//   - Active side highlighted in nct-soft.
//   - Disabled while the assistant is still streaming.
//   - Optimistic toggle: click active side = un-vote (DELETE-like),
//     click other side = switch (POST). On 5xx we revert + surface a
//     toast so the user knows the click didn't take.
//   - When the admin has set "verbose dislike" ON, clicking 👎 on
//     a fresh dislike opens a modal that asks for a reason. The
//     reason is sent on submit. When OFF, 👎 submits immediately.
//
// Props:
//   answerId: the server-generated ULID stamped on the agent response.
//   disabled: true while the assistant is still streaming (busy).
//   initialVote: optional pre-hydrated vote (-1 | 0 | 1) from the
//                my-votes batch endpoint.
//
// Emits:
//   vote-submitted: { answerId, vote, reason? } — for tests + analytics.

import { computed, ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'
import { useToast } from '@/composables/useToast'
import DislikeReasonModal from './DislikeReasonModal.vue'

const props = defineProps<{
  answerId: string
  disabled?: boolean
  initialVote?: -1 | 0 | 1
}>()

const emit = defineEmits<{
  (e: 'vote-submitted', payload: { answerId: string; vote: -1 | 0 | 1; reason?: string }): void
}>()

const api = useApi()
const toast = useToast()

// `myVote` is the local optimistic state. -1 = dislike, 0 = none,
// 1 = like. Kept in sync with the server through the optimistic
// update + the server response. The `busy` flag is set during the
// round-trip so a rapid double-click doesn't double-submit.
const myVote = ref<-1 | 0 | 1>(props.initialVote ?? 0)
const busy = ref(false)
const reasonModalOpen = ref(false)
const verboseDislike = ref(false)

// On first mount + whenever initialVote changes (re-hydration from
// a different chat), snap to the new value. The watcher also handles
// the case where AskPage passes initialVote=undefined on the very
// first render and then a hydrated value arrives.
watch(() => props.initialVote, (v) => {
  if (typeof v === 'number') myVote.value = v as -1 | 0 | 1
})

// Verbose flag is fetched lazily — first click on 👎 triggers the
// fetch if we don't have it. We don't fetch on mount because the
// cost (a network round-trip) is not worth it for users who never
// dislike anything. The result is cached for the lifetime of the
// component.
async function ensureVerbose(): Promise<boolean> {
  // Server admin gate — `/dashboard/api/feedback/settings` requires
  // an admin cookie. When called from a user session, the proxy
  // returns 401. We treat that as "verbose off" because the user
  // surface shouldn't crash on a settings probe.
  try {
    // The admin endpoint isn't in useApi; we hit the proxy directly.
    // The response is `verbose_dislike: boolean`.
    const r = await fetch('/dashboard/api/feedback/settings', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) {
      verboseDislike.value = false
      return false
    }
    const j = (await r.json()) as { verbose_dislike: boolean }
    verboseDislike.value = !!j.verbose_dislike
    return verboseDislike.value
  } catch {
    verboseDislike.value = false
    return false
  }
}

async function submitVote(vote: 1 | -1, reason?: string): Promise<void> {
  if (busy.value || props.disabled) return
  const previous = myVote.value
  myVote.value = vote // optimistic
  busy.value = true
  try {
    await api.submitFeedbackVote({ answer_id: props.answerId, vote, reason })
    emit('vote-submitted', { answerId: props.answerId, vote, reason })
  } catch (e) {
    // Revert. The toast helper deduplicates by message so a rapid
    // back-to-back failure doesn't spam the screen.
    myVote.value = previous
    toast.error('A szavazat nem ment el. Próbáld újra.')
    // eslint-disable-next-line no-console
    console.error('[feedback] vote failed', e)
  } finally {
    busy.value = false
  }
}

async function onLikeClick(): Promise<void> {
  if (props.disabled) return
  // Same side = un-vote (optimistic — flip to 0 first, then POST).
  // Different side / no vote = POST 1. The server's state machine
  // matches: same incoming vs existing → DELETE, different → UPSERT.
  const previous = myVote.value
  const next: -1 | 0 | 1 = myVote.value === 1 ? 0 : 1
  myVote.value = next
  busy.value = true
  try {
    await api.submitFeedbackVote({ answer_id: props.answerId, vote: 1 })
    emit('vote-submitted', { answerId: props.answerId, vote: next, reason: undefined })
  } catch (e) {
    myVote.value = previous
    toast.error('A szavazat nem ment el. Próbáld újra.')
    // eslint-disable-next-line no-console
    console.error('[feedback] vote failed', e)
  } finally {
    busy.value = false
  }
}

async function onDislikeClick(): Promise<void> {
  if (props.disabled) return
  if (myVote.value === -1) {
    // Already disliked — un-vote (optimistic).
    const previous = myVote.value
    myVote.value = 0
    busy.value = true
    try {
      await api.submitFeedbackVote({ answer_id: props.answerId, vote: -1 })
      emit('vote-submitted', { answerId: props.answerId, vote: 0 })
    } catch (e) {
      myVote.value = previous
      toast.error('A szavazat nem ment el. Próbáld újra.')
      // eslint-disable-next-line no-console
      console.error('[feedback] vote failed', e)
    } finally {
      busy.value = false
    }
    return
  }
  // Fresh dislike: check verbose, optionally open modal.
  const verbose = await ensureVerbose()
  if (verbose) {
    reasonModalOpen.value = true
    return
  }
  await submitVote(-1)
}

function onReasonModalSubmit(reason: string): void {
  reasonModalOpen.value = false
  // The modal pre-pends 'other:' for the free-text branch; for
  // fixed reasons it's a plain string. Both are valid input to
  // submitVote.
  void submitVote(-1, reason)
}

const isDisabled = computed(() => !!props.disabled || busy.value)
const likeClasses = computed(() =>
  myVote.value === 1
    ? 'text-nct-soft'
    : 'text-text-muted hover:text-text-secondary',
)
const dislikeClasses = computed(() =>
  myVote.value === -1
    ? 'text-nct-soft'
    : 'text-text-muted hover:text-text-secondary',
)
</script>

<template>
  <div
    class="flex items-center justify-end gap-1"
    data-testid="answer-vote-bar"
  >
    <button
      type="button"
      :aria-label="myVote === 1 ? 'Tetszik — szavazat törlése' : 'Tetszik'"
      :aria-pressed="myVote === 1"
      :disabled="isDisabled"
      class="inline-flex items-center justify-center w-7 h-7 rounded-md
             transition-colors duration-150
             focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
             disabled:opacity-40 disabled:cursor-not-allowed"
      :class="likeClasses"
      data-testid="answer-vote-bar-like"
      @click="onLikeClick"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        class="w-4 h-4"
        :fill="myVote === 1 ? 'currentColor' : 'none'"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M7 11V21H4a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1h3z" />
        <path d="M7 11l4-8a2 2 0 0 1 2 1.7l-0.5 3.3H20a2 2 0 0 1 2 2.3l-1.5 8A2 2 0 0 1 18.5 21H7" />
      </svg>
    </button>
    <button
      type="button"
      :aria-label="myVote === -1 ? 'Nem tetszik — szavazat törlése' : 'Nem tetszik'"
      :aria-pressed="myVote === -1"
      :disabled="isDisabled"
      class="inline-flex items-center justify-center w-7 h-7 rounded-md
             transition-colors duration-150
             focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
             disabled:opacity-40 disabled:cursor-not-allowed"
      :class="dislikeClasses"
      data-testid="answer-vote-bar-dislike"
      @click="onDislikeClick"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        class="w-4 h-4"
        :fill="myVote === -1 ? 'currentColor' : 'none'"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M17 13V3h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3z" />
        <path d="M17 13l-4 8a2 2 0 0 1-2-1.7l0.5-3.3H4a2 2 0 0 1-2-2.3l1.5-8A2 2 0 0 1 5.5 3H17" />
      </svg>
    </button>
    <DislikeReasonModal
      v-if="reasonModalOpen"
      :open="reasonModalOpen"
      :answer-id="answerId"
      @update:open="reasonModalOpen = $event"
      @submitted="onReasonModalSubmit"
    />
  </div>
</template>
