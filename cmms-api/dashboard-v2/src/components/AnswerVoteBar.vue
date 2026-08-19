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
//   - Clicking 👎 on a fresh dislike always opens the reason modal
//     (5 fixed reasons + "Other" free text). Submitting the modal
//     commits the dislike + the reason. The reason is stored on the
//     feedback_votes row so the dev team can see *why* a model
//     output was wrong, not just that it was.
//
// Props:
//   answerId: the server-generated ULID stamped on the agent response.
//   disabled: true while the assistant is still streaming (busy).
//   initialVote: optional pre-hydrated vote (-1 | 0 | 1) from the
//                my-votes batch endpoint.
//
// Emits:
//   vote-submitted: { answerId, vote, reason? } — for tests + analytics.
//   dislike-confirmed: { answerId } — fires when a dislike vote is
//                      committed (with or without a reason). The
//                      parent (AskPage) uses this to render the
//                      "Tudod a helyes választ? Küldd el a
//                      fejlesztésnek!" inline link below the answer
//                      bubble. NOT fired on un-vote or switch-to-like.
//   dislike-cleared: { answerId } — fires when a previously-disliked
//                     answer is un-voted (click 👎 again) OR switched
//                     to a like. The parent uses this to hide the
//                     "Küldd el" link.

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
  (e: 'dislike-confirmed', payload: { answerId: string }): void
  (e: 'dislike-cleared', payload: { answerId: string }): void
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

// On first mount + whenever initialVote changes (re-hydration from
// a different chat), snap to the new value. The watcher also handles
// the case where AskPage passes initialVote=undefined on the very
// first render and then a hydrated value arrives.
watch(() => props.initialVote, (v) => {
  if (typeof v === 'number') myVote.value = v as -1 | 0 | 1
})

async function submitVote(vote: 1 | -1, reason?: string): Promise<void> {
  if (busy.value || props.disabled) return
  const previous = myVote.value
  const isFreshDislike = vote === -1 && previous !== -1
  myVote.value = vote // optimistic
  busy.value = true
  try {
    await api.submitFeedbackVote({ answer_id: props.answerId, vote, reason })
    emit('vote-submitted', { answerId: props.answerId, vote, reason })
    if (isFreshDislike) {
      // Tell the parent so it can render the "Tudod a helyes
      // választ? Küldd el a fejlesztésnek!" inline link below the
      // answer bubble. Fires AFTER vote-submitted so the parent's
      // first paint of the link matches the now-disliked state.
      emit('dislike-confirmed', { answerId: props.answerId })
    }
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
    if (previous === -1) {
      // Switching away from a dislike — hide the "Küldd el" link.
      emit('dislike-cleared', { answerId: props.answerId })
    }
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
      emit('dislike-cleared', { answerId: props.answerId })
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
  // Fresh dislike: always open the reason modal. The user is
  // intentionally downvoting — a single click without context is
  // not actionable for the dev team. The reason modal is also the
  // gateway to the post-dislike "Küldd el a helyes választ" link
  // (handled by AskPage via the dislike-confirmed event), so the
  // modal must fire BEFORE the suggestion text appears.
  reasonModalOpen.value = true
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
