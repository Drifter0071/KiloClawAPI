<script setup lang="ts">
// src/components/CorrectionModal.vue
//
// Standalone "share the correct answer" modal. Opens when the user
// clicks the inline "Küldd el a fejlesztésnek!" link that appears
// below a freshly-disliked answer bubble.
//
// Wire shape:
//   - Props: { open, answerId, busy? }
//   - Emits:
//     - update:open(boolean)  — the standard v-model contract.
//     - submitted(correction: string)  — fires when the user clicks
//       Elküld with non-empty text. The parent (AskPage) is
//       responsible for the network call to
//       /v1/feedback/correction; the modal itself just collects the
//       text. We deliberately do NOT do the fetch here so the
//       "busy" lock + error toast are owned by the parent and
//       share state with the rest of the page (no double toasts).
//
// The 1000-char cap matches the server's CORRECTION_MAX_LEN (see
// src/routes/feedback.ts). Browser maxlength="1000" prevents typing
// past it; the v-model side also trims + slices as a belt-and-
// braces guard.

import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  answerId: string
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'submitted', correction: string): void
}>()

const CORRECTION_MAX = 1000
const correction = ref<string>('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const correctionLen = computed(() => correction.value.length)
const trimmed = computed(() => correction.value.trim())
const canSubmit = computed(() => trimmed.value.length > 0 && !props.busy)

// Reset on open. Focus the textarea so the user can type
// immediately (no extra click).
watch(() => props.open, async (open) => {
  if (open) {
    correction.value = ''
    await nextTick()
    textareaRef.value?.focus()
  }
})

function close(): void {
  if (props.busy) return
  emit('update:open', false)
}

function onSubmit(): void {
  if (!canSubmit.value) return
  emit('submitted', trimmed.value.slice(0, CORRECTION_MAX))
}

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150 ease-out"
      leave-active-class="transition-opacity duration-150 ease-in"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center
               bg-black/45 backdrop-blur-[10px] backdrop-saturate-[.85]
               p-4"
        role="presentation"
        data-testid="correction-backdrop"
        @click="onBackdropClick"
        @keydown="onKeydown"
      >
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-150 ease-in"
        >
          <div
            v-if="open"
            class="w-full max-w-md bg-surface border border-border-subtle rounded-2xl
                   shadow-2xl overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="correction-title"
            data-testid="correction-modal"
            @click.stop
          >
            <div class="px-5 pt-5 pb-2">
              <h2
                id="correction-title"
                class="text-[15px] font-semibold text-text-primary"
                data-testid="correction-title"
              >
                Helyes válasz elküldése
              </h2>
              <p class="mt-1 text-[12px] text-text-muted">
                Ha tudod, mi lett volna a helyes válasz, írd be —
                közvetlenül a fejlesztéshez jut el.
              </p>
            </div>
            <form
              class="px-5 pb-4 pt-1"
              data-testid="correction-form"
              @submit.prevent="onSubmit"
            >
              <textarea
                ref="textareaRef"
                v-model="correction"
                rows="5"
                :maxlength="1000"
                placeholder="A helyes válasz…"
                class="w-full text-[13px] text-text-primary bg-surface-2
                       border border-border-subtle rounded-lg
                       px-2.5 py-2
                       focus:outline-none focus:border-nct-soft/60
                       focus:ring-2 focus:ring-nct-soft/30
                       resize-none"
                data-testid="correction-textarea"
              />
              <div class="text-right text-[10px] font-mono text-text-muted mt-0.5">
                {{ correctionLen }} / 1000
              </div>
            </form>
            <div class="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2">
              <button
                type="button"
                :disabled="busy"
                class="px-3 py-1.5 text-[13px] font-medium rounded-md
                       text-text-secondary hover:bg-surface-2
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
                       disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="correction-cancel"
                @click="close"
              >
                Mégse
              </button>
              <button
                type="button"
                :disabled="!canSubmit"
                class="px-3 py-1.5 text-[13px] font-medium rounded-md
                       text-white
                       bg-[var(--nct-accent,#452b68)] hover:bg-[var(--nct-soft,#452b68)]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
                data-testid="correction-submit"
                @click="onSubmit"
              >
                Elküld
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
