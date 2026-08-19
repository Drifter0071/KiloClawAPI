<script setup lang="ts">
// src/components/ConfirmDialog.vue
//
// Generic confirm/cancel dialog. Used by the conversation rail for
// thread-delete and a few other places (admin token rotation etc).
//
// Two-way bound via v-model:open. Emits:
//   - confirm: user clicked the destructive/primary button
//   - cancel:  user dismissed (X, scrim, Escape, cancel button)
//
// The dialog is teleported to <body> so it sits above any
// stacking context, and body scroll is locked while open.

import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    /** Optional detail line shown below the title (e.g. conversation
     *  name). Rendered as muted secondary text. */
    detail?: string
    /** Label on the primary action. Default: "Törlés". */
    confirmLabel?: string
    /** Label on the cancel action. Default: "Mégse". */
    cancelLabel?: string
    /** Tone of the confirm button. Default: "danger" (red).
     *  "primary" is used for non-destructive confirmations. */
    tone?: 'danger' | 'primary'
    /** Disable the confirm button (e.g. while a network call is
     *  in flight, the parent sets pending=true). */
    pending?: boolean
  }>(),
  {
    confirmLabel: 'Törlés',
    cancelLabel: 'Mégse',
    tone: 'danger',
    pending: false,
  },
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

function close(): void {
  emit('cancel')
  emit('update:open', false)
}

function onConfirm(): void {
  if (props.pending) return
  emit('confirm')
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
  // Tab trap: keep focus inside the dialog
  if (e.key === 'Tab' && dialogRef.value) {
    const focusable = dialogRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }
}

const dialogRef = ref<HTMLElement | null>(null)

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    document.body.style.overflow = ''
  })
}

let prevOverflow = ''
watch(
  () => props.open,
  (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) {
      prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = prevOverflow
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="dialogRef"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      data-testid="confirm-dialog"
    >
      <div
        class="absolute inset-0 bg-black/50 backdrop-blur-sm"
        data-testid="confirm-dialog-scrim"
        @click="close"
      />

      <div
        class="relative w-full max-w-md rounded-2xl
               border border-border-default bg-surface text-text-primary
               shadow-lg p-5"
        @click.stop
      >
        <h2 class="text-base font-semibold leading-tight mb-1">{{ title }}</h2>
        <p v-if="detail" class="text-[13px] text-text-muted leading-relaxed truncate mb-2">
          {{ detail }}
        </p>
        <p v-if="description" class="text-[13px] text-text-secondary leading-relaxed mb-4">
          {{ description }}
        </p>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-md text-sm
                   border border-border-default text-text-primary
                   hover:bg-surface-2 transition-colors
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
            :disabled="pending"
            data-testid="confirm-dialog-cancel"
            autofocus
            @click="close"
          >
            {{ cancelLabel }}
          </button>
          <button
            type="button"
            :class="tone === 'danger'
              ? 'bg-danger text-white hover:opacity-90'
              : 'bg-nct-soft text-white hover:opacity-90'"
            class="px-3 py-1.5 rounded-md text-sm font-medium
                   disabled:opacity-40 disabled:cursor-not-allowed
                   transition-opacity
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
            :disabled="pending"
            data-testid="confirm-dialog-confirm"
            @click="onConfirm"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
