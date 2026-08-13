// src/stores/ask.ts
//
// Ask page chat history (in-memory for v1).
//
// One store per page visit; the Ask page pushes a UserMessage on
// submit and an AssistantMessage when the answer lands (or an error
// message when it fails). Stream/Diff hand questions over via
// `setSeedQ()` (useSeedQ.ts) so the Ask history stays the single
// source of truth for past questions.

import { defineStore } from 'pinia'
import { ref } from 'vue'
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

export const useAskStore = defineStore('ask', () => {
  const messages = ref<ChatMessage[]>([])
  /** True while an answer request is in flight (disables the AskBar). */
  const busy = ref(false)

  function push(m: ChatMessage) {
    messages.value.push(m)
  }

  function clear() {
    messages.value = []
  }

  return { messages, busy, push, clear }
})
