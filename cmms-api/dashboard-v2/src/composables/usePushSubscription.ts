// src/composables/usePushSubscription.ts
//
// Phase 8 (2026-08-24), brainstorm idea F2 — Web Push subscription.
// The dashboard SPA subscribes to push notifications so the server
// can deliver "your background job finished" alerts to the user's
// device even when the dashboard tab is closed.
//
// Flow:
//   1. On mount, fetch /v1/push/public-key. If !enabled, bail.
//   2. Check `Notification.permission`. If "default", show a "subscribe"
//      affordance. If "denied", the OS won't let us re-ask — hide.
//   3. On subscribe: call `registration.pushManager.subscribe(...)` with
//      the VAPID public key, POST the resulting PushSubscription to
//      /v1/push/subscribe (server stores in push_subscriptions).
//   4. On unsubscribe: DELETE the subscription from the server.
//
// We do NOT auto-subscribe on every page load — that would be hostile.
// The affordance is exposed via the `promptSubscribe()` method which
// the parent (a settings panel / banner) calls only on user intent.

import { ref } from 'vue'

const SUPPORTED = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window

export type PushSupportState = 'unsupported' | 'denied' | 'default' | 'granted'

function currentPermission(): PushSupportState {
  if (!SUPPORTED) return 'unsupported'
  if (!('Notification' in window)) return 'unsupported'
  const p = Notification.permission
  if (p === 'denied') return 'denied'
  if (p === 'granted') return 'granted'
  return 'default'
}

export interface PushStatus {
  enabled: boolean
  subscribed: boolean
  permission: PushSupportState
  count: number
  publicKey: string | null
}

export function usePushSubscription() {
  const enabled = ref<boolean>(false)
  const publicKey = ref<string | null>(null)
  const permission = ref<PushSupportState>(currentPermission())
  const subscribed = ref<boolean>(false)
  const deviceCount = ref<number>(0)
  const busy = ref<boolean>(false)
  const lastError = ref<string | null>(null)

  async function fetchStatus(): Promise<void> {
    try {
      const r = await fetch('/dashboard/api/push/public-key', { credentials: 'include' })
      if (!r.ok) {
        enabled.value = false
        return
      }
      const data = (await r.json()) as { enabled: boolean; publicKey: string | null }
      enabled.value = data.enabled
      publicKey.value = data.publicKey
      permission.value = currentPermission()
      // Refresh the device count for this uid (only if logged in).
      await fetchDeviceCount()
      // Check if we're already subscribed (e.g. service worker survived a reload).
      if (enabled.value && permission.value === 'granted' && publicKey.value) {
        try {
          const reg = await navigator.serviceWorker.ready
          const existing = await reg.pushManager.getSubscription()
          subscribed.value = !!existing
        } catch {
          // service worker not registered — fine, the user just isn't subscribed yet
        }
      }
    } catch (e) {
      lastError.value = String((e as Error).message ?? e)
      enabled.value = false
    }
  }

  async function fetchDeviceCount(): Promise<void> {
    try {
      const r = await fetch('/dashboard/api/push/status', { credentials: 'include' })
      if (!r.ok) {
        deviceCount.value = 0
        return
      }
      const data = (await r.json()) as { count: number }
      deviceCount.value = data.count ?? 0
    } catch {
      deviceCount.value = 0
    }
  }

  function urlBase64ToUint8Array(base64String: string): BufferSource {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(base64)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out as unknown as BufferSource
  }

  async function promptSubscribe(): Promise<boolean> {
    if (!SUPPORTED) {
      lastError.value = 'A böngésző nem támogatja a push értesítéseket.'
      return false
    }
    if (!enabled.value || !publicKey.value) {
      lastError.value = 'A push szolgáltatás nincs engedélyezve a szerveren.'
      return false
    }
    busy.value = true
    lastError.value = null
    try {
      const perm = await Notification.requestPermission()
      permission.value = currentPermission()
      if (perm !== 'granted') {
        lastError.value = 'A felhasználó elutasította a push engedélyt.'
        return false
      }
      const reg = await navigator.serviceWorker.ready
      // Re-subscribe is idempotent — if a sub exists, just re-attach
      // the server side with the new keys (rare, but harmless).
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey.value),
      })
      const json = sub.toJSON()
      const endpoint = sub.endpoint
      const p256dh = json.keys?.p256dh
      const auth = json.keys?.auth
      if (!endpoint || !p256dh || !auth) {
        lastError.value = 'A push subscription érvénytelen volt.'
        return false
      }
      const r = await fetch('/dashboard/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
      })
      if (!r.ok) {
        lastError.value = `A szerver elutasította a feliratkozást (${r.status}).`
        return false
      }
      subscribed.value = true
      await fetchDeviceCount()
      return true
    } catch (e) {
      lastError.value = String((e as Error).message ?? e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function unsubscribe(): Promise<boolean> {
    if (!SUPPORTED) return false
    busy.value = true
    lastError.value = null
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await fetch('/dashboard/api/push/subscribe', {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
        await sub.unsubscribe()
      }
      subscribed.value = false
      await fetchDeviceCount()
      return true
    } catch (e) {
      lastError.value = String((e as Error).message ?? e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function sendTest(): Promise<{ delivered: number; failed: number; pruned: number } | null> {
    if (!SUPPORTED || !subscribed.value) return null
    try {
      const r = await fetch('/dashboard/api/push/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!r.ok) return null
      return (await r.json()) as { delivered: number; failed: number; pruned: number }
    } catch {
      return null
    }
  }

  return {
    supported: SUPPORTED,
    enabled,
    permission,
    subscribed,
    deviceCount,
    busy,
    lastError,
    publicKey,
    fetchStatus,
    promptSubscribe,
    unsubscribe,
    sendTest,
  }
}
