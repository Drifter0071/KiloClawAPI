import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  ts: number
  meta?: any
}

/**
 * Ask page history (in-memory for v1).
 * Phase 5.1 will wire this to the Ask page render path; Phase 2 just
 * lays down the store shape so other composables can import it safely.
 */
export const useAskStore = defineStore('ask', () => {
  const messages = ref<ChatMessage[]>([])
  const busy = ref(false)
  function push(m: ChatMessage) {
    messages.value.push(m)
  }
  function clear() {
    messages.value = []
  }
  return { messages, busy, push, clear }
})
