// src/stores/ask.ts
//
// Ask page chat history — per-CLIENT threads, persisted in browser
// localStorage (user decision 2026-08-13: browser storage, auto-split
// by the question's extracted customer).
//
// A thread key is the normalized `filters.customer` from the answer;
// questions without a customer ("M26057 vezérlés") land in "general".
// Storage keys:
//   cmms_chat:<key>   — ChatMessage[] for one thread
//   cmms_chat_index   — known threads [{key,label,count,updated}]
//   cmms_chat_active  — last active thread key (restored on reload)
//
// The Ask page keeps rendering `store.messages` — that's now a computed
// over the ACTIVE thread, so the page code didn't have to change shape.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AnswerResponse } from '@/lib/api'

export interface ChatMessageMeta {
  /** The full AnswerResponse when the assistant message rendered. */
  answer?: AnswerResponse
  /** Set when the message is an inline error instead of an answer. */
  error?: string
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  ts: number
  meta?: ChatMessageMeta
}

export interface ThreadInfo {
  key: string
  /** Display label — the customer name, or "General". */
  label: string
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

/** Thread key for an answer: its resolved customer, or "general". */
export function threadKeyFromAnswer(a: AnswerResponse): string {
  const c = a.filters?.customer
  if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  return GENERAL_KEY
}

export function threadLabel(key: string): string {
  return key === GENERAL_KEY ? 'General' : key
}

export const useAskStore = defineStore('ask', () => {
  const busy = ref(false)
  /** Render-only LLM rewrite toggle. Default OFF, in-memory per session
   *  (user decision: the deterministic path stays the source of truth;
   *  the operator opts into the LLM per visit). NOT persisted. */
  const llmOn = ref(false)
  const threadKey = ref<string>(readJson<string>(ACTIVE_KEY, GENERAL_KEY))
  const index = ref<ThreadInfo[]>(readJson<ThreadInfo[]>(INDEX_KEY, []))

  const threads = ref<Record<string, ChatMessage[]>>(
    Object.fromEntries(
      index.value.map((t) => [t.key, readJson<ChatMessage[]>(`cmms_chat:${t.key}`, [])]),
    ),
  )

  /** Messages of the ACTIVE thread — what the Ask page renders. */
  const messages = computed<ChatMessage[]>(() => threads.value[threadKey.value] ?? [])

  function ensureIndexEntry(key: string): void {
    if (!index.value.some((t) => t.key === key)) {
      index.value.push({ key, label: threadLabel(key), count: 0, updated: Date.now() })
    }
  }

  function saveThread(key: string): void {
    const msgs = threads.value[key] ?? []
    ensureIndexEntry(key)
    const entry = index.value.find((t) => t.key === key)!
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
    const i = index.value.findIndex((t) => t.key === threadKey.value)
    if (i >= 0) index.value[i] = { ...index.value[i]!, count: 0, updated: Date.now() }
    saveThread(threadKey.value)
  }

  /**
   * Auto-split: when a fresh answer resolves to a customer different
   * from the active thread, switch to that customer's thread (loading
   * its history). Non-customer questions go to "general".
   */
  function resolveThreadFromAnswer(a: AnswerResponse): void {
    const key = threadKeyFromAnswer(a)
    if (key !== threadKey.value) switchThread(key)
  }

  return {
    busy,
    llmOn,
    messages,
    threadKey,
    index,
    push,
    clearThread,
    switchThread,
    resolveThreadFromAnswer,
  }
})
