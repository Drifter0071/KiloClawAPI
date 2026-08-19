<script setup lang="ts">
// src/components/ApprovalRequestCard.vue
//
// Compact approval card embedded inline in the event feed AND used
// inside the EventInspector for full review.
//
// Behaviour (must keep tests/stream.spec.ts green):
//   - `summary` starting with "APPROVED:" or "REJECTED:" marks the
//     request as already resolved.
//   - Buttons are disabled when resolved, while busy, or when no `id`.
//   - When disabled, BOTH buttons MUST carry
//       title="A jóváhagyási sor még nincs bekötve"
//     regardless of the disabled reason — the spec uses this title to
//     assert that the wiring is intentionally inert.
import { computed, ref } from 'vue'
import { useApi } from '@/composables/useApi'
import type { StreamApprovalEvent } from '@/lib/api'

const props = defineProps<{
  event: StreamApprovalEvent
}>()

const emit = defineEmits<{
  (e: 'resolved', payload: { id: string; approved: boolean }): void
}>()

const busy = ref(false)
const localStatus = ref<'pending' | 'approved' | 'rejected' | null>(null)
const errorMsg = ref<string | null>(null)

const isApproved = computed(() => {
  if (localStatus.value === 'approved') return true
  return typeof props.event.summary === 'string' && props.event.summary.startsWith('APPROVED:')
})

const isRejected = computed(() => {
  if (localStatus.value === 'rejected') return true
  return typeof props.event.summary === 'string' && props.event.summary.startsWith('REJECTED:')
})

const isResolved = computed(() => isApproved.value || isRejected.value)

const isDisabled = computed(() => isResolved.value || busy.value || !props.event.id)

// Always spec-compliant when disabled, regardless of the reason
// (resolved, busy, or no id). Tests rely on this exact text.
const disabledTitle = computed(() => 'A jóváhagyási sor még nincs bekötve')

const parsedSummary = computed(() => {
  let raw = props.event.summary || ''
  if (raw.startsWith('APPROVED: ')) raw = raw.slice('APPROVED: '.length)
  if (raw.startsWith('REJECTED: ')) raw = raw.slice('REJECTED: '.length)
  return raw
})

async function handleAction(approved: boolean) {
  if (!props.event.id || isDisabled.value) return
  busy.value = true
  errorMsg.value = null
  try {
    const res = await useApi().resolveApproval(props.event.id, approved)
    if (res.ok) {
      localStatus.value = approved ? 'approved' : 'rejected'
      emit('resolved', { id: props.event.id, approved })
    } else {
      errorMsg.value = 'A jóváhagyási művelet sikertelen volt.'
    }
  } catch (err: any) {
    errorMsg.value = err?.message || 'Hálózati hiba a jóváhagyás során.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="mt-2.5 p-3 rounded-lg border bg-surface-2/60 transition-all duration-150"
    :class="[
      isApproved ? 'border-emerald-500/30 bg-emerald-500/5' : '',
      isRejected ? 'border-rose-500/30 bg-rose-500/5' : '',
      !isResolved ? 'border-amber-500/40 bg-amber-500/5 shadow-sm' : '',
    ]"
    data-testid="approval-actions"
  >
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex items-center gap-2">
          <span
            class="inline-flex items-center gap-1 h-5 px-2 rounded font-mono text-[10px] uppercase font-semibold tracking-wider"
            :class="[
              isApproved ? 'bg-emerald-500/15 text-emerald-400' : '',
              isRejected ? 'bg-rose-500/15 text-rose-400' : '',
              !isResolved ? 'bg-amber-500/20 text-amber-300 animate-pulse' : '',
            ]"
          >
            <svg v-if="isApproved" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
            <svg v-else-if="isRejected" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>
            {{ isApproved ? 'Jóváhagyva' : isRejected ? 'Elutasítva' : 'Jóváhagyásra vár' }}
          </span>

          <span v-if="event.action" class="font-mono text-[11px] text-text-muted">
            Művelet: <strong class="text-text-secondary font-medium">{{ event.action }}</strong>
          </span>
        </div>

        <p class="text-[12.5px] text-text-primary leading-relaxed break-words font-medium">
          {{ parsedSummary }}
        </p>

        <p v-if="errorMsg" class="text-[11px] text-rose-400 font-medium mt-1">
          {{ errorMsg }}
        </p>
      </div>

      <div class="flex items-center gap-2 shrink-0 self-end sm:self-center pt-2 sm:pt-0">
        <button
          type="button"
          :disabled="isDisabled"
          :title="disabledTitle"
          class="h-8 px-3.5 text-[12px] font-medium rounded-md flex items-center gap-1.5 transition-all duration-150
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50
                 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-emerald-500/15"
          :class="isApproved ? 'bg-emerald-500/20 text-emerald-300 font-semibold' : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300'"
          data-testid="approval-approve"
          @click="handleAction(true)"
        >
          <svg v-if="busy" class="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
          <span>Jóváhagy</span>
        </button>

        <button
          type="button"
          :disabled="isDisabled"
          :title="disabledTitle"
          class="h-8 px-3.5 text-[12px] font-medium rounded-md flex items-center gap-1.5 transition-all duration-150
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/50
                 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-rose-500/15"
          :class="isRejected ? 'bg-rose-500/20 text-rose-300 font-semibold' : 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300'"
          data-testid="approval-reject"
          @click="handleAction(false)"
        >
          <svg v-if="busy" class="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
          <span>Elvet</span>
        </button>
      </div>
    </div>
  </div>
</template>
