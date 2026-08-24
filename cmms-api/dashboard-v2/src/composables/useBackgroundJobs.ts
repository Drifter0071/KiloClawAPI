// src/composables/useBackgroundJobs.ts
//
// Phase 8 (2026-08-24), brainstorm idea A9 + F3 — "ask and leave".
// Persists in-flight async agent jobs to localStorage so a page
// reload (or navigating away) doesn't lose the question. On mount,
// the SPA polls every persisted job and finalizes the answer into
// the right thread (the submitKey is also stored).
//
// The ask endpoint already returns `{ job_id, status: "running" }`
// immediately; the existing `/v1/answer-agent/async/:jobId` polls
// for `done` / `error`. We layer a localStorage cache on top so
// the user's question survives a refresh.
//
// Why localStorage and not just in-memory?
//   - The user's primary use case is "type a long question, lock
//     the phone, come back 5 min later". The phone may have closed
//     the tab. The job itself is server-side (5-min hard timeout),
//     but the SPA needs to know to POLL it on the next open.
//   - localStorage key is namespaced `nct-bg-jobs-v1`; we can wipe
//     and migrate by bumping the version.

import { ref } from 'vue'

const STORAGE_KEY = 'nct-bg-jobs-v1'

export interface BackgroundJob {
  job_id: string
  /** The question text — what to show in the rail / pending card. */
  q: string
  /** Thread the question was asked in. Used to land the answer
   *  in the right place when it comes back. */
  submit_key: string
  /** Wall-clock start (ms). Used for "started 3 min ago" UI. */
  started_at: number
  /** When the answer is finalized we remove the row. */
  status: 'running' | 'done' | 'error'
  /** The final answer text (only set when status === 'done').
   *  Stored so a reload AFTER the answer came back still shows it
   *  in the thread before the next chat session. */
  final_text?: string
  /** Error message when status === 'error'. */
  error?: string
  /** Whether the user has been notified. Used to suppress double
   *  toasts / pushes if the same job is seen twice. */
  notified?: boolean
}

function readAll(): BackgroundJob[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Filter out stale completed jobs (24h). They're never re-polled
    // but we keep them around so a quick reload still sees the answer.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return parsed.filter(
      (j): j is BackgroundJob =>
        !!j &&
        typeof (j as BackgroundJob).job_id === 'string' &&
        typeof (j as BackgroundJob).q === 'string' &&
        typeof (j as BackgroundJob).started_at === 'number' &&
        (j as BackgroundJob).started_at >= cutoff,
    )
  } catch {
    return []
  }
}

function writeAll(list: BackgroundJob[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // storage unavailable — best-effort only
  }
}

// Module-level singleton (like useMachineScope).
const jobs = ref<BackgroundJob[]>(readAll())
const pollers = new Map<string, ReturnType<typeof setInterval>>()

function persist(): void {
  writeAll(jobs.value)
}

export function useBackgroundJobs() {
  function track(job: Omit<BackgroundJob, 'started_at' | 'status'>): void {
    const entry: BackgroundJob = {
      ...job,
      started_at: Date.now(),
      status: 'running',
    }
    jobs.value = [...jobs.value, entry]
    persist()
  }

  function markDone(jobId: string, finalText: string): void {
    jobs.value = jobs.value.map((j) =>
      j.job_id === jobId ? { ...j, status: 'done', final_text: finalText } : j,
    )
    persist()
    stopPolling(jobId)
  }

  function markError(jobId: string, error: string): void {
    jobs.value = jobs.value.map((j) =>
      j.job_id === jobId ? { ...j, status: 'error', error } : j,
    )
    persist()
    stopPolling(jobId)
  }

  function markNotified(jobId: string): void {
    jobs.value = jobs.value.map((j) =>
      j.job_id === jobId ? { ...j, notified: true } : j,
    )
    persist()
  }

  function remove(jobId: string): void {
    jobs.value = jobs.value.filter((j) => j.job_id !== jobId)
    persist()
    stopPolling(jobId)
  }

  function startPolling(jobId: string, onDone: (final: string) => void, onError: (err: string) => void): void {
    stopPolling(jobId)
    let attempts = 0
    const MAX_ATTEMPTS = 200 // ~10 min at 3s interval
    const tick = async (): Promise<void> => {
      attempts += 1
      try {
        // dynamic import to avoid a circular dep with useApi
        const { useApi } = await import('@/composables/useApi')
        const api = useApi()
        const state = await api.answerAgentPoll(jobId)
        if (state.status === 'done' && state.result) {
          onDone(state.result.final_text)
          return
        }
        if (state.status === 'error') {
          onError(state.error?.message ?? 'A válasz elkészítése meghiúsult.')
          return
        }
      } catch (e) {
        // 404 = job vanished. Treat as error.
        onError('A válasz készítése megszakadt (a szerver újraindult).')
        return
      }
      if (attempts >= MAX_ATTEMPTS) {
        onError('A válasz készítése túl sokáig tartott.')
        return
      }
    }
    // First tick immediately, then every 3s.
    void tick()
    const handle = setInterval(() => void tick(), 3000)
    pollers.set(jobId, handle)
  }

  function stopPolling(jobId: string): void {
    const h = pollers.get(jobId)
    if (h) {
      clearInterval(h)
      pollers.delete(jobId)
    }
  }

  function clearAll(): void {
    for (const id of pollers.keys()) stopPolling(id)
    jobs.value = []
    persist()
  }

  return {
    jobs,
    track,
    markDone,
    markError,
    markNotified,
    remove,
    startPolling,
    stopPolling,
    clearAll,
  }
}
