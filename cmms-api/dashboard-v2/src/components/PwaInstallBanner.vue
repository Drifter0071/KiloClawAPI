<script setup lang="ts">
// src/components/PwaInstallBanner.vue
//
// Mobile-first PWA install prompt (2026-08-24). Mounts globally; the
// banner only renders when:
//   - the user is on a mobile viewport AND
//   - the app isn't already installed as a PWA AND
//   - we have either a deferred `beforeinstallprompt` (Android/Chrome)
//     OR we're on iOS Safari (so we show the manual "Add to Home
//     Screen" hint instead)
//
// On desktop we never show it. After accept/dismiss, a 14-day
// cooldown suppresses it (handled in usePwaInstall).

import { computed, ref } from 'vue'
import { usePwaInstall } from '@/composables/usePwaInstall'
import { useMediaQuery } from '@/composables/useMediaQuery'

const pwa = usePwaInstall()
const isMobile = useMediaQuery('(max-width: 767px)')

// Auto-show after a small delay so the banner doesn't pop on first
// paint. The user has 2 seconds of "calm" to read the page first.
const visible = ref(false)
setTimeout(() => {
  visible.value = true
}, 2000)

const shouldShow = computed(() => {
  if (!isMobile.value) return false
  if (pwa.installed.value) return false
  if (pwa.dismissed.value) return false
  return pwa.canShow.value || pwa.isIosWithoutStandalone.value
})

async function onInstallClick() {
  const result = await pwa.install()
  if (result === 'unavailable') {
    // Chrome on Android sometimes drops the deferred event after a
    // hot-reload or permission denial — fall back to the iOS-style
    // hint by setting a manual dismissed flag.
    pwa.dismiss()
  }
}

function onDismiss() {
  pwa.dismiss()
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-transform transition-opacity duration-200"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition-transform transition-opacity duration-150"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-if="visible && shouldShow"
        class="fixed left-3 right-3 z-30 bottom-[max(4.5rem,calc(4rem+env(safe-area-inset-bottom)))]
               md:bottom-3 md:left-auto md:right-3 md:w-80
               bg-canvas-2 border border-border-default rounded-lg shadow-lg shadow-black/40
               p-3 flex items-start gap-3"
        data-testid="pwa-install-banner"
        role="dialog"
        aria-label="Alkalmazás telepítése"
      >
        <div class="shrink-0 w-9 h-9 rounded-lg bg-nct-soft/15 text-nct-soft inline-flex items-center justify-center" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[13px] font-semibold text-text-primary">
            Telepítsd a kezdőképernyőre
          </p>
          <p class="text-[12px] text-text-muted leading-snug mt-0.5">
            <template v-if="pwa.isIosWithoutStandalone.value">
              Nyomd meg a <span class="font-mono text-text-primary">Megosztás</span> ikont, majd <span class="font-mono text-text-primary">Hozzáadás a Főképernyőhöz</span>.
            </template>
            <template v-else>
              Gyorsabb indítás, teljes képernyős hang-komisszió.
            </template>
          </p>
          <div class="mt-2 flex items-center gap-2">
            <button
              v-if="pwa.canShow.value"
              type="button"
              class="h-8 px-3 rounded-md bg-nct-soft text-canvas text-[12px] font-medium
                     hover:bg-nct-soft/90 transition-colors duration-150
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="pwa-install-confirm"
              @click="onInstallClick"
            >
              Telepítés
            </button>
            <button
              type="button"
              class="h-8 px-2.5 rounded-md text-text-muted text-[12px]
                     hover:text-text-primary hover:bg-surface-2 transition-colors duration-150
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="pwa-install-dismiss"
              @click="onDismiss"
            >
              Most nem
            </button>
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 w-7 h-7 -m-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors duration-150
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Bezárás"
          @click="onDismiss"
        >✕</button>
      </div>
    </Transition>
  </Teleport>
</template>
