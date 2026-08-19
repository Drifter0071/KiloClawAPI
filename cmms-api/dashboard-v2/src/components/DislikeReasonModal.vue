<script setup lang="ts">
// src/components/DislikeReasonModal.vue
//
// Modal that opens when the user clicks 👎 while the admin has the
// "verbose dislike" flag ON. 5 fixed reasons + "Other" (free text,
// required).
//
// The "share the correct answer" follow-up is a SEPARATE flow: after
// the user submits a reason, the AskPage renders an inline "Tudod a
// helyes választ? Küldd el a fejlesztésnek!" link below the answer
// bubble. Clicking that link opens CorrectionModal (separate
// component), not this one. Keeping the reason modal small and
// focused reduces the cognitive load of the dislike step.
//
// Wire format: 5 fixed reasons are passed verbatim; the "Other"
// branch prefixes the textarea value with "other:" so the server
// treats it as the open-text bucket.

import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  answerId: string
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'submitted', reason: string): void
}>()

// 5 fine-tune-actionable reasons + Other. Order matters for the
// admin's triage — most likely root cause first.
const REASONS: Array<{ id: string; label: string; value: string }> = [
  { id: 'wrong-customer', label: 'Hibás ügyfél / eszköz', value: 'wrong customer/device' },
  { id: 'wrong-data', label: 'Hibás adat (szám / dátum / darabszám)', value: 'wrong data (number/date/count)' },
  { id: 'missed-tickets', label: 'Kihagyott releváns ticket(ek)', value: 'missed relevant ticket(s)' },
  { id: 'made-up', label: 'Kitalált információ', value: 'made something up' },
  { id: 'wording', label: 'Csak a megfogalmazás / formátum rossz', value: 'wording/format only' },
]
const OTHER_VALUE = '__other__'

const selected = ref<string>('')
const otherText = ref<string>('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const isOther = computed(() => selected.value === OTHER_VALUE)
const canSubmit = computed(() => {
  if (selected.value === '') return false
  if (isOther.value && otherText.value.trim().length === 0) return false
  return true
})

// Reset on open. Default focus on the first reason (a click pattern
// the user already knows from a Button).
watch(() => props.open, async (open) => {
  if (open) {
    selected.value = ''
    otherText.value = ''
    // Focus the first radio so keyboard users can pick a reason with
    // one Space/Enter. We also call focus() on close so a user
    // pressing Enter on the open button keeps the focus chain
    // (MŰKÖDÉS / accessibility).
    await nextTick()
    const first = document.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-0"]')
    first?.focus()
  }
})

function close(): void {
  emit('update:open', false)
}

function onSubmit(): void {
  if (!canSubmit.value) return
  if (isOther.value) {
    emit('submitted', `other:${otherText.value.trim().slice(0, 280)}`)
  } else {
    emit('submitted', selected.value)
  }
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
        data-testid="dislike-reason-backdrop"
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
            aria-labelledby="dislike-reason-title"
            data-testid="dislike-reason-modal"
            @click.stop
          >
            <div class="px-5 pt-5 pb-2">
              <h2
                id="dislike-reason-title"
                class="text-[15px] font-semibold text-text-primary"
                data-testid="dislike-reason-title"
              >
                Mi volt a baj ezzel a válasszal?
              </h2>
              <p class="mt-1 text-[12px] text-text-muted">
                A válasz segít a modell tanításában.
              </p>
            </div>
            <form
              class="px-5 pb-4 pt-1 space-y-1"
              data-testid="dislike-reason-form"
              @submit.prevent="onSubmit"
            >
              <label
                v-for="(r, i) in REASONS"
                :key="r.id"
                class="flex items-start gap-2.5 py-2 px-2 rounded-lg
                       hover:bg-surface-2 cursor-pointer
                       focus-within:bg-surface-2"
                :data-testid="`dislike-reason-option-${r.id}`"
              >
                <input
                  v-model="selected"
                  type="radio"
                  :value="r.value"
                  name="dislike-reason"
                  class="mt-0.5 shrink-0 accent-[var(--nct-soft,#3d275c)]"
                  :data-testid="`dislike-reason-radio-${i}`"
                />
                <span class="text-[13px] text-text-primary leading-snug">{{ r.label }}</span>
              </label>
              <label
                class="flex items-start gap-2.5 py-2 px-2 rounded-lg
                       hover:bg-surface-2 cursor-pointer
                       focus-within:bg-surface-2"
                data-testid="dislike-reason-option-other"
              >
                <input
                  v-model="selected"
                  type="radio"
                  :value="OTHER_VALUE"
                  name="dislike-reason"
                  class="mt-0.5 shrink-0 accent-[var(--nct-soft,#3d275c)]"
                  data-testid="dislike-reason-radio-other"
                />
                <span class="text-[13px] text-text-primary leading-snug">Egyéb</span>
              </label>
              <div v-if="isOther" class="pl-7 pt-1 pb-2" data-testid="dislike-reason-other-wrap">
                <textarea
                  ref="textareaRef"
                  v-model="otherText"
                  rows="3"
                  maxlength="280"
                  placeholder="Írd le röviden…"
                  class="w-full text-[13px] text-text-primary bg-surface-2
                         border border-border-subtle rounded-lg
                         px-2.5 py-2
                         focus:outline-none focus:border-nct-soft/60
                         focus:ring-2 focus:ring-nct-soft/30
                         resize-none"
                  data-testid="dislike-reason-other-textarea"
                />
                <div class="text-right text-[10px] font-mono text-text-muted mt-0.5">
                  {{ otherText.length }} / 280
                </div>
              </div>
            </form>
            <div class="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-[13px] font-medium rounded-md
                       text-text-secondary hover:bg-surface-2
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
                data-testid="dislike-reason-cancel"
                @click="close"
              >
                Mégse
              </button>
              <button
                type="button"
                :disabled="!canSubmit"
                class="px-3 py-1.5 text-[13px] font-medium rounded-md
                       text-white
                       bg-[var(--nct-accent,#3d275c)] hover:bg-[var(--nct-soft,#3d275c)]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
                data-testid="dislike-reason-submit"
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
