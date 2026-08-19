<script setup lang="ts">
// src/components/RestoreConfirmationDialog.vue
//
// High-risk confirmation dialog for diff restoration. The current
// /api/diff endpoint does NOT expose a restore mutation, so the
// dialog is wired into the page but only invoked when the user has
// actually selected a restorable change AND explicit restore support
// is announced by the wire shape.
//
// Safety details (kept here so the spec stays verifiable in one
// place):
//
//   - The Cancel button is the *default* focused element so a stray
//     Enter does NOT confirm.
//   - The Confirm button is type="button" (never submit) and is
//     disabled while `pending` is true.
//   - The dialog copy quotes the exact baseline date and the exact
//     item count — no marketing copy.
//   - No claim that the operation is reversible unless the wire
//     guarantees it (the current stub doesn't, so we explicitly say
//     "A művelet nem visszavonható.").
//   - The trigger button (Restore) must be a separate, secondary
//     action; this dialog is never opened by a primary action.
import { computed, nextTick, ref, watch } from 'vue'
import Button from '@/components/Button.vue'
import type { DiffChange } from '@/lib/api'
import { formatHuDateTimeWithZone, truncate } from '@/lib/diff'

const props = defineProps<{
  open: boolean
  /** When restoring a single change. When null, this is a batch
   *  restore confirmation. */
  single: DiffChange | null
  /** Batch selection. Ignored when `single` is non-null. */
  batch: ReadonlyArray<DiffChange>
  /** Baseline ISO of the diff that produced this restore request. */
  since: string | null
  /** Pending flag — disables the confirm button while the network
   *  request is in flight. */
  pending?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const cancelRef = ref<HTMLButtonElement | null>(null)

const targetCount = computed(() => (props.single ? 1 : props.batch.length))
const targetLabel = computed(() => {
  if (props.single) {
    return `rekord: ${props.single.id} · ${truncate(String(props.single.after ?? ''), 80)}`
  }
  if (props.batch.length === 0) return 'nincs kijelölt rekord'
  if (props.batch.length === 1) {
    return `rekord: ${props.batch[0]!.id}`
  }
  return `${props.batch.length} rekord`
})
const baselineText = computed(() =>
  props.since
    ? formatHuDateTimeWithZone(props.since)
    : 'a kiválasztott korábbi állapot',
)

function close() {
  if (props.pending) return
  emit('update:open', false)
  emit('cancel')
}
function onConfirm() {
  if (props.pending) return
  emit('confirm')
}

function onKeydown(evt: KeyboardEvent) {
  if (!props.open) return
  if (evt.key === 'Escape') {
    evt.stopPropagation()
    close()
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) {
      document.addEventListener('keydown', onKeydown)
      // Focus Cancel so an accidental Enter dismisses the dialog
      // instead of confirming. Satisfies the spec's "do not allow
      // accidental confirmation while focus is on the wrong
      // control" rule.
      await nextTick()
      cancelRef.value?.focus()
    } else {
      document.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]"
      aria-hidden="true"
      data-testid="restore-dialog-backdrop"
      @click="close"
    />
    <div
      v-if="open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-dialog-title"
      class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-canvas-2 border border-border-default rounded-lg shadow-2xl shadow-black/50 p-6"
      data-testid="restore-dialog"
    >
      <div class="flex items-start gap-3">
        <div
          class="shrink-0 w-9 h-9 rounded-full bg-warning/15 flex items-center justify-center"
          aria-hidden="true"
        >
          <svg
            class="w-5 h-5 text-warning"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <h2
            id="restore-dialog-title"
            class="text-base font-semibold text-text-primary leading-snug"
          >
            Visszaállítás megerősítése
          </h2>
          <p class="mt-2 text-[13px] text-text-secondary leading-relaxed">
            <template v-if="targetCount === 1">
              Biztosan visszaállítod a kijelölt 1 elemet a
              <span class="font-mono text-text-primary">{{ baselineText }}</span>
              állapotára? A jelenlegi értékek felülíródhatnak.
            </template>
            <template v-else>
              Biztosan visszaállítod a kijelölt
              <span class="font-mono text-text-primary">{{ targetCount }}</span>
              elemet a
              <span class="font-mono text-text-primary">{{ baselineText }}</span>
              állapotára? A jelenlegi értékek felülíródhatnak.
            </template>
          </p>
          <p
            class="mt-2 text-[12px] text-text-muted font-mono"
            data-testid="restore-dialog-target"
          >
            {{ targetLabel }}
          </p>
          <p class="mt-3 text-[12px] text-warning font-medium">
            A művelet nem visszavonható.
          </p>
        </div>
      </div>

      <div class="mt-6 flex items-center justify-end gap-2">
        <Button
          ref="cancelRef"
          variant="secondary"
          size="md"
          :disabled="pending"
          data-testid="restore-dialog-cancel"
          @click="close"
        >
          Mégse
        </Button>
        <Button
          variant="primary"
          size="md"
          class="!bg-warning hover:!bg-warning focus-visible:!ring-warning/40 text-text-inverse"
          :loading="pending"
          :disabled="pending"
          data-testid="restore-dialog-confirm"
          @click="onConfirm"
        >
          Visszaállítás végrehajtása
        </Button>
      </div>
    </div>
  </Teleport>
</template>
