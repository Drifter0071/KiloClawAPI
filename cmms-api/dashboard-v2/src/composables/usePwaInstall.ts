// src/composables/usePwaInstall.ts
//
// PWA install prompt helper (mobile-first polish, 2026-08-24).
//
// Captures the browser's `beforeinstallprompt` event so we can show a
// "Telepítsd a kezdőképernyőre" banner that the user can accept or
// dismiss. On iOS Safari the event never fires — we expose
// `isIosWithoutStandalone` so the banner can show a manual hint
// ("Open in Safari → Share → Add to Home Screen") instead.
//
// The install state is persisted in localStorage so we don't keep
// nagging the user after they've either installed or explicitly
// dismissed the prompt.

import { computed, onBeforeUnmount, ref } from 'vue'

const STORAGE_KEY = 'nct-pwa-install-dismissed-v1'
const COOLDOWN_DAYS = 14

interface BeforeInstallPromptEventLike {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const deferred = ref<BeforeInstallPromptEventLike | null>(null)
const installed = ref(false)
const dismissed = ref(false)
const isIosWithoutStandalone = ref(false)

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as {
    matchMedia?: (q: string) => { matches: boolean }
    navigator?: { standalone?: boolean }
  }
  const mediaStandalone = w.matchMedia?.('(display-mode: standalone)').matches ?? false
  const navStandalone = w.navigator?.standalone === true
  return mediaStandalone || navStandalone
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function readDismissedUntil(): number {
  if (typeof localStorage === 'undefined') return 0
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function markDismissed() {
  if (typeof localStorage === 'undefined') return
  const until = Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  localStorage.setItem(STORAGE_KEY, String(until))
  dismissed.value = true
}

function init() {
  if (typeof window === 'undefined') return
  if (isStandalone()) {
    installed.value = true
    return
  }
  if (isIos()) {
    isIosWithoutStandalone.value = true
  }
  // Cooldown: don't re-prompt for 14 days after a dismissal.
  if (Date.now() < readDismissedUntil()) {
    dismissed.value = true
  }

  const onBeforeInstall = (e: Event) => {
    e.preventDefault()
    deferred.value = e as unknown as BeforeInstallPromptEventLike
  }
  const onInstalled = () => {
    installed.value = true
    deferred.value = null
  }
  window.addEventListener('beforeinstallprompt', onBeforeInstall)
  window.addEventListener('appinstalled', onInstalled)

  onBeforeUnmount(() => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall)
    window.removeEventListener('appinstalled', onInstalled)
  })
}

// Single shared instance across the whole app. We do the install
// listeners once at module load, then expose the same refs to all
// callers.
init()

export function usePwaInstall() {
  async function install(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!deferred.value) return 'unavailable'
    try {
      await deferred.value.prompt()
      const choice = await deferred.value.userChoice
      if (choice.outcome === 'accepted') {
        installed.value = true
      } else {
        markDismissed()
      }
      deferred.value = null
      return choice.outcome
    } catch {
      return 'unavailable'
    }
  }

  function dismiss() {
    markDismissed()
  }

  return {
    /** True once the app is installed as a PWA. */
    installed,
    /** True when the user has dismissed the prompt within the cooldown. */
    dismissed,
    /** True when running on iOS Safari without already being installed. */
    isIosWithoutStandalone,
    /** True when a beforeinstallprompt has been captured. */
    canShow: computed(() => !!deferred.value),
    install,
    dismiss,
  }
}
