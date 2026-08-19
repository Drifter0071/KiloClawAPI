// src/composables/useMachineScope.ts
//
// Machine-scoped ask: the operator picks ONE machine before asking
// ("M26057" etc.), and every question in that session is scoped to it
// via the request's `context: { device }` field. The backend injects
// it as a default scope system message — the user's own wording in the
// question still takes precedence.
//
// Module-level singleton (like useApi): AskPage and MachineScopeBar
// share the same reactive state. Persisted in localStorage so the
// scope survives reloads (the operator is usually working on one
// machine at a time).

import { ref } from 'vue'

const STORAGE_KEY = 'nct-machine-scope-v1'

function readStored(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { device?: unknown }
    return typeof parsed?.device === 'string' ? parsed.device.trim() : ''
  } catch {
    return ''
  }
}

function persist(device: string): void {
  try {
    if (device.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify({ device }))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable — scope stays in-memory only
  }
}

const device = ref<string>(readStored())

function setDevice(name: string): void {
  device.value = (name ?? '').trim()
  persist(device.value)
}

function clearScope(): void {
  device.value = ''
  persist('')
}

export function useMachineScope() {
  return { device, setDevice, clearScope }
}
