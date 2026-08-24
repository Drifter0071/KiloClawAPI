// src/stores/ask.ts
//
// Ask page chat history — per-CLIENT threads, persisted in browser
// localStorage (user decision 2026-08-13: browser storage, auto-split
// by the question's extracted customer).
//
// A thread key is the normalized customer the answer resolved to
// (`filters.customer` from the deterministic answer, or
// `resolved_customer` from the agentic answer); questions without a
// customer ("M26057 vezérlés") land in "general". Storage keys:
//   cmms_chat:<key>   — ChatMessage[] for one thread
//   cmms_chat_index   — known threads [{key,label,count,updated}]
//   cmms_chat_active  — last active thread key (restored on reload)
//
// The Ask page keeps rendering `store.messages` — that's now a computed
// over the ACTIVE thread, so the page code didn't have to change shape.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AnswerAgentResponse, AnswerResponse, AnswerFilters } from '@/lib/api'

export interface ChatMessageMeta {
  /** The full AnswerResponse when the assistant message rendered the
   *  legacy deterministic answer (kept to render stored history). */
  answer?: AnswerResponse
  /** The full AnswerAgentResponse when the assistant message rendered
   *  the agentic answer (the current Ask path). */
  agent?: AnswerAgentResponse
  /** Set when the message is an inline error instead of an answer. */
  error?: string
  /** Set when the message is a user-submitted correction attached to
   *  a previously-disliked answer. Carries the answer_id it
   *  corrects so the admin view can group it with the source answer
   *  in the feedback_corrections table. */
  correction?: {
    answer_id: string
    correction: string
    created_at: string
  }
  /** Set when the message is a "háttérben fut" placeholder (Phase 8,
   *  2026-08-24). The job_id is set once the server mints it; until
   *  then `q` is the question text and the bubble is a thin "Fut a
   *  háttérben" notice. */
  background?: {
    job_id: string
    q: string
  }
}

export type ChatMessage = {
  role: 'user' | 'assistant' | 'correction'
  text: string
  ts: number
  meta?: ChatMessageMeta
}

export interface ThreadInfo {
  key: string
  /** Display label — the customer name, or "General". */
  label: string
  /** Display title — the FIRST user message of the thread (truncated),
   *  or "" when the thread has no user message yet. The thread
   *  switcher shows this instead of the raw customer key. */
  title: string
  count: number
  updated: number
}

export const GENERAL_KEY = 'general'
const INDEX_KEY = 'cmms_chat_index'
const ACTIVE_KEY = 'cmms_chat_active'

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // privacy mode / disabled storage
  }
}

function readJson<T>(key: string, fallback: T): T {
  const s = ls()
  if (!s) return fallback
  try {
    const raw = s.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  const s = ls()
  if (!s) return
  try {
    s.setItem(key, JSON.stringify(value))
  } catch {
    // quota exceeded — drop the write; threads are a convenience layer
  }
}

/** Thread key for an answer: its resolved customer, or "general".
 *  Accepts both the legacy AnswerResponse (filters.customer) and the
 *  agentic AnswerAgentResponse (resolved_customer).
 *
 *  The customer string is normalized: trailing hyphens/spaces (a known
 *  router quirk — the customer_tickets_list extractor appends "-")
 *  are stripped so "PLASMA-TECH SYSTEMS KFT.-" and
 *  "PLASMA-TECH SYSTEMS KFT." land in the SAME thread instead of
 *  producing near-duplicate chat names. */
export function threadKeyFromAnswer(a: {
  filters?: AnswerFilters | null
  resolved_customer?: string | null
}): string {
  const c = a.resolved_customer ?? a.filters?.customer
  if (typeof c === 'string' && c.trim().length > 0) {
    const t = c.trim().replace(/[-\s]+$/, '')
    if (t.length > 0) return t
  }
  return GENERAL_KEY
}

export function threadLabel(key: string): string {
  return key === GENERAL_KEY ? 'General' : key
}

/** Display title of a thread = its first user message (whitespace
 *  collapsed, truncated to ~48 chars). Fallback: the customer label. */
export function threadTitle(msgs: ChatMessage[]): string {
  const first = msgs.find((m) => m.role === 'user')
  if (!first) return ''
  const t = first.text.trim().replace(/\s+/g, ' ')
  return t.length > 48 ? `${t.slice(0, 48)}…` : t
}

export const useAskStore = defineStore('ask', () => {
  const busy = ref(false)
  const threadKey = ref<string>(readJson<string>(ACTIVE_KEY, GENERAL_KEY))
  const index = ref<ThreadInfo[]>(readJson<ThreadInfo[]>(INDEX_KEY, []))

  const threads = ref<Record<string, ChatMessage[]>>(
    Object.fromEntries(
      index.value.map((t) => [t.key, readJson<ChatMessage[]>(`cmms_chat:${t.key}`, [])]),
    ),
  )

  /** Messages of the ACTIVE thread — what the Ask page renders. */
  const messages = computed<ChatMessage[]>(() => threads.value[threadKey.value] ?? [])

  /** Title shown on the switcher pill: the active thread's first-message
   *  title, falling back to its customer label. A fresh unnamed
   *  "chat-…" thread reads "Új beszélgetés". */
  const activeTitle = computed<string>(() => {
    const t = index.value.find((t) => t.key === threadKey.value)
    if (t?.title) return t.title
    if (threadKey.value.startsWith('chat-')) return 'Új beszélgetés'
    return threadLabel(threadKey.value)
  })

  function ensureIndexEntry(key: string): void {
    if (!index.value.some((t) => t.key === key)) {
      index.value.push({ key, label: threadLabel(key), title: '', count: 0, updated: Date.now() })
    }
  }

  function saveThread(key: string): void {
    const msgs = threads.value[key] ?? []
    const idx = index.value.findIndex((t) => t.key === key)
    // A thread with no messages is not a conversation — drop it from the
    // index (keeps the menu free of empty "chat-…" entries after the
    // auto-split moves the question to its customer thread).
    if (msgs.length === 0) {
      if (idx >= 0) {
        index.value = index.value.filter((t) => t.key !== key)
        writeJson(INDEX_KEY, index.value)
      }
      return
    }
    ensureIndexEntry(key)
    const entry = index.value.find((t) => t.key === key)!
    entry.title = threadTitle(msgs)
    entry.count = msgs.length
    if (msgs.length > 0) entry.updated = msgs[msgs.length - 1]!.ts
    index.value = [...index.value].sort((a, b) => b.updated - a.updated)
    writeJson(INDEX_KEY, index.value)
    writeJson(`cmms_chat:${key}`, msgs)
  }

  function persistActive(): void {
    writeJson(ACTIVE_KEY, threadKey.value)
  }

  /** Append to the ACTIVE thread and persist. */
  function push(m: ChatMessage): void {
    if (!threads.value[threadKey.value]) threads.value[threadKey.value] = []
    threads.value[threadKey.value]!.push(m)
    saveThread(threadKey.value)
  }

  /** Append to a SPECIFIC thread (not necessarily the active one).
   *  Used by the Ask page to land the assistant response in the
   *  thread the user asked the question in — even if the user has
   *  navigated to a different thread mid-flight. */
  function pushForThread(key: string, m: ChatMessage): void {
    if (!threads.value[key]) threads.value[key] = []
    threads.value[key]!.push(m)
    saveThread(key)
  }

  /**
   * In-flight submission tracker. The Ask page calls this on every
   * submit / retry with the (run, threadKey) pair, so that when the
   * network response comes back we can route the answer to the SAME
   * thread the user asked it in — even if the user has switched
   * threads mid-flight. Without this, a slow answer would land in
   * whatever thread the user is now looking at, which feels broken
   * (the user sees a question asked in thread A producing an answer
   * in thread B).
   */
  const pendingRuns = ref<Record<number, string>>({})

  function registerPendingRun(run: number, key: string): void {
    pendingRuns.value = { ...pendingRuns.value, [run]: key }
  }

  function consumePendingRun(run: number): string | null {
    const key = pendingRuns.value[run]
    return typeof key === 'string' ? key : null
  }

  function clearPendingRun(run: number): void {
    if (!(run in pendingRuns.value)) return
    const next = { ...pendingRuns.value }
    delete next[run]
    pendingRuns.value = next
  }

  /**
   * Compute the routing decision for an incoming answer.
   *
   * Returns:
   *   threadKey:          the thread to push the answer into
   *   shouldSwitchActive: true when the active thread should be moved
   *                       to the answer thread (so the user sees the
   *                       new answer land). False when the question
   *                       was asked in a different thread and the user
   *                       is now somewhere else — switching would
   *                       yank them out of their current context.
   *
   * Special case (2026-08-24): when the submit key is an EXPLICIT
   * "Új beszélgetés" thread (`chat-*`, created via startNewChat()),
   * the user has signalled "keep this in the fresh chat, don't move
   * it". The auto-split would yank the question + answer out of the
   * new chat and glue them onto the resolved customer thread — which
   * is exactly what the user asked us NOT to do. We land the answer
   * in the new chat and never switch active.
   */
  function pickThreadForAnswer(
    a: AnswerResponse | AnswerAgentResponse,
    submitKey: string,
  ): { threadKey: string; shouldSwitchActive: boolean } {
    const resolved = threadKeyFromAnswer(a)
    if (resolved === submitKey) {
      return { threadKey: submitKey, shouldSwitchActive: false }
    }
    if (submitKey.startsWith('chat-')) {
      // Explicit "new chat" — keep the question + answer here, no
      // matter what customer the answer resolved to. The user can
      // still navigate to the customer thread manually if they want.
      return { threadKey: submitKey, shouldSwitchActive: false }
    }
    if (submitKey === threadKey.value) {
      // The user is still on the thread they asked in. Auto-split
      // makes sense — they'll see the answer appear in the resolved
      // customer thread (which is what they care about).
      return { threadKey: resolved, shouldSwitchActive: true }
    }
    // The user is on a different thread now. Land the answer in the
    // resolved thread (so it's grouped with the right customer's
    // history) but DON'T switch the user's active view.
    return { threadKey: resolved, shouldSwitchActive: false }
  }

  /**
   * Auto-split helper: if the submit thread's last message is an
   * UNANSWERED user question (i.e. nothing since the last assistant
   * message), move that question to the resolved thread. Used by the
   * Ask page right before `switchThread(resolved)`, so the user's
   * question + the assistant's answer end up together in the customer
   * thread.
   */
  function moveTrailingQuestion(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return
    const srcMsgs = threads.value[fromKey] ?? []
    let split = -1
    for (let i = srcMsgs.length - 1; i >= 0; i -= 1) {
      if (srcMsgs[i]!.role === 'assistant') {
        split = i
        break
      }
    }
    const trailing = split >= 0 ? srcMsgs.slice(split + 1) : srcMsgs
    if (trailing.length === 0) return
    if (!threads.value[toKey]) threads.value[toKey] = []
    threads.value[toKey]!.push(...trailing)
    saveThread(toKey)
    threads.value[fromKey] = split >= 0 ? srcMsgs.slice(0, split + 1) : []
    saveThread(fromKey)
  }

  /** Remove a thread entirely (its messages + index entry). */
  function removeThread(key: string): void {
    delete threads.value[key]
    index.value = index.value.filter((t) => t.key !== key)
    writeJson(INDEX_KEY, index.value)
    try {
      ls()?.removeItem(`cmms_chat:${key}`)
    } catch {
      // ignore
    }
    if (threadKey.value === key) {
      threadKey.value = GENERAL_KEY
      persistActive()
    }
  }

  /** Switch to another thread, loading its stored history. */
  function switchThread(key: string): void {
    if (!threads.value[key]) {
      threads.value[key] = readJson<ChatMessage[]>(`cmms_chat:${key}`, [])
    }
    ensureIndexEntry(key)
    threadKey.value = key
    persistActive()
  }

  /** Clear the ACTIVE thread's messages (history + index entry). */
  function clearThread(): void {
    threads.value[threadKey.value] = []
    saveThread(threadKey.value)
  }

  /**
   * Remove `count` messages starting at `startIdx` from the ACTIVE
   * thread. Used by the retry-from-error flow to clean up the failed
   * user message + error bubble before re-sending.
   */
  function spliceMessages(startIdx: number, count: number): void {
    const key = threadKey.value
    const msgs = threads.value[key]
    if (!msgs || startIdx < 0 || startIdx >= msgs.length) return
    msgs.splice(startIdx, count)
    saveThread(key)
  }

  /**
   * Start a fresh, empty conversation. Reuses the "general" thread when
   * it has no history yet; otherwise mints a timestamped key that gets
   * its title from the first message once the user asks something (the
   * auto-split still routes customer-resolving questions into their
   * customer thread).
   */
  function startNewChat(): void {
    const key =
      (threads.value[GENERAL_KEY] ?? []).length === 0 ? GENERAL_KEY : `chat-${Date.now()}`
    if (!threads.value[key]) threads.value[key] = []
    threadKey.value = key
    persistActive()
  }

  /**
   * Auto-split: when a fresh answer resolves to a customer different
   * from the active thread, switch to that customer's thread (loading
   * its history). Non-customer questions go to "general".
   *
   * The question that produced this answer was pushed to the OLD thread
   * at submit time; if it hasn't been answered yet (it sits after the
   * last assistant message), carry it over to the resolved thread so
   * user + assistant stay together in the customer's history.
   */
  function resolveThreadFromAnswer(a: AnswerResponse | AnswerAgentResponse): void {
    const key = threadKeyFromAnswer(a)
    if (key === threadKey.value) return
    const src = threadKey.value
    const srcMsgs = threads.value[src] ?? []
    // Find the last assistant message; anything after it is an
    // unanswered user question belonging to THIS answer.
    let split = -1
    for (let i = srcMsgs.length - 1; i >= 0; i -= 1) {
      if (srcMsgs[i]!.role === 'assistant') {
        split = i
        break
      }
    }
    const trailing = split >= 0 ? srcMsgs.slice(split + 1) : srcMsgs
    switchThread(key)
    if (trailing.length > 0) {
      if (!threads.value[key]) threads.value[key] = []
      threads.value[key]!.push(...trailing)
      saveThread(key)
    }
    if (trailing.length > 0) {
      threads.value[src] = split >= 0 ? srcMsgs.slice(0, split + 1) : []
      saveThread(src)
    }
  }

  return {
    busy,
    messages,
    activeTitle,
    threadKey,
    index,
    push,
    pushForThread,
    clearThread,
    spliceMessages,
    switchThread,
    startNewChat,
    resolveThreadFromAnswer,
    registerPendingRun,
    consumePendingRun,
    clearPendingRun,
    pickThreadForAnswer,
    moveTrailingQuestion,
    removeThread,
  }
})
