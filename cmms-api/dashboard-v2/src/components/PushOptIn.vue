<script setup lang="ts">
// src/components/PushOptIn.vue
//
// Phase 8 (2026-08-24), brainstorm idea F2 — the "Értesítés ha kész"
// chip next to the AskBar's "Háttérben" submit. When push is
// supported, enabled, and not yet granted, the chip shows a "Push
// értesítés bekapcsolása" CTA. Once granted, it becomes a quiet
// check + a small "test" button. The component is invisible when
// push isn't supported or the user already opted in.

import { onMounted, ref } from 'vue'
import { usePushSubscription } from '@/composables/usePushSubscription'
import { useToast } from '@/composables/useToast'

const push = usePushSubscription()
const toast = useToast()
const showChip = ref(false)
const sending = ref(false)

onMounted(async () => {
  await push.fetchStatus()
  // Show the chip only when (a) the browser supports push, (b) the
  // server has VAPID keys, (c) permission is still in 'default'
  // (haven't asked yet). If already granted, we don't pester.
  showChip.value =
    push.supported &&
    push.enabled.value &&
    push.permission.value === 'default'
})

async function onEnable() {
  const ok = await push.promptSubscribe()
  if (ok) {
    showChip.value = false
    toast.success('Push értesítés bekapcsolva. A háttérben futó válaszokról push-t is kapsz.')
  } else {
    toast.error(push.lastError.value ?? 'Nem sikerült bekapcsolni a push értesítést.')
  }
}

async function onTest() {
  sending.value = true
  const r = await push.sendTest()
  sending.value = false
  if (!r) {
    toast.error('Nem sikerült teszt push-t küldeni.')
    return
  }
  if (r.delivered > 0) toast.success(`Teszt push elküldve (${r.delivered} eszközre).`)
  else toast.warn('A push elküldve, de egy eszközre sem ért célba. Ellenőrizd az engedélyt.')
}
</script>

<template>
  <div
    v-if="showChip || push.subscribed.value"
    class="flex items-center gap-1.5 text-[11px]"
    data-testid="push-opt-in"
  >
    <!-- Default state: nudge to enable -->
    <button
      v-if="showChip"
      type="button"
      class="h-7 px-2.5 rounded-full
             bg-surface-2 border border-border-subtle
             text-text-secondary hover:text-text-primary hover:border-nct-soft/40
             transition-colors duration-150
             focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
             inline-flex items-center gap-1.5"
      :disabled="push.busy.value"
      data-testid="push-opt-in-enable"
      @click="onEnable"
    >
      <svg
        width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"
        class="text-nct-soft"
      >
        <path
          d="M8 2a4 4 0 0 0-4 4v3l-1 1.5a.5.5 0 0 0 .4.8h9.2a.5.5 0 0 0 .4-.8L12 9V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>{{ push.busy.value ? 'Bekapcsolás…' : 'Push értesítés' }}</span>
    </button>
    <!-- Subscribed: quiet check + a test button so the user can
         verify the round-trip. The chip stays visible so the user
         knows push is on. -->
    <div
      v-else
      class="inline-flex items-center gap-1.5 text-text-muted"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" class="text-success">
        <path d="M2 6.2L4.6 8.8 10 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>Push aktív</span>
      <button
        type="button"
        class="ml-1 text-[10.5px] text-nct-soft hover:text-nct-soft/80 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40 rounded"
        :disabled="sending"
        data-testid="push-opt-in-test"
        @click="onTest"
      >
        {{ sending ? 'Küldés…' : 'Teszt' }}
      </button>
    </div>
  </div>
</template>
