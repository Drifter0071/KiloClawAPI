<script setup lang="ts">
// src/routes/SharedAnswerPage.vue
//
// Phase 8 (2026-08-24), brainstorm idea F4 — shareable answer link
// view. The operator copies `/dashboard/v2/answer/<id>` from the
// agent bubble's "Share" button and pastes it to a colleague. The
// colleague opens the link, logs in, and sees the original answer
// without needing the original chat thread.
//
// Auth: login-required (the proxy returns 401 if the user is not
// authenticated; the page shows a friendly message + a link to
// the login form). The URL is permanent — there's no expiry on
// feedback_answers rows.
//
// What's shown:
//   - The original question (q)
//   - The agent's final_text (the body of the answer)
//   - The tool trace (collapsed)
//   - The model + iteration count + creation date as a footer
//
// What's NOT shown:
//   - The like / dislike bar (you can't vote on someone else's
//     thread; votes are uid-bound)
//   - The follow-up chips (they don't apply — the answer is a
//     historical snapshot)
//   - The conversation rail (this is a standalone view)

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'
import AgentBody from '@/components/AgentBody.vue'

const route = useRoute()
const router = useRouter()
const api = useApi()

const id = computed(() => String(route.params.id ?? ''))
const loading = ref<boolean>(true)
const notFound = ref<boolean>(false)
const unauthorized = ref<boolean>(false)
const data = ref<{
  answer_id: string
  q: string
  final_text: string
  model: string
  iterations: number
  language: string
  created_at: string
  tool_trace: unknown
} | null>(null)

const showTools = ref<boolean>(false)

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const months = [
    'január', 'február', 'március', 'április', 'május', 'június',
    'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
  ]
  return `${d.getFullYear()}. ${months[d.getMonth()]} ${d.getDate()}.`
}

onMounted(async () => {
  try {
    const r = await fetch(`/dashboard/api/feedback/answer/${encodeURIComponent(id.value)}`, {
      credentials: 'include',
    })
    if (r.status === 401) {
      unauthorized.value = true
      return
    }
    if (r.status === 404) {
      notFound.value = true
      return
    }
    if (!r.ok) {
      notFound.value = true
      return
    }
    data.value = (await r.json()) as typeof data.value
  } catch {
    notFound.value = true
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="h-full overflow-y-auto px-4 md:px-6 py-6 md:py-10" data-testid="shared-answer-page">
    <div class="max-w-[860px] mx-auto space-y-5">
      <!-- Back to Ask -->
      <button
        type="button"
        class="inline-flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-primary
               focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40 rounded px-1 py-0.5"
        data-testid="shared-answer-back"
        @click="router.push('/ask')"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10 4l-4 4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Vissza az Ask-hoz
      </button>

      <div
        v-if="loading"
        class="space-y-3"
        data-testid="shared-answer-loading"
      >
        <div class="h-6 w-2/3 rounded bg-surface-2 animate-shimmer" />
        <div class="h-4 w-1/2 rounded bg-surface-2 animate-shimmer" />
        <div class="h-32 w-full rounded bg-surface-2 animate-shimmer" />
      </div>

      <div
        v-else-if="unauthorized"
        class="rounded-lg border border-warning/30 bg-warning/[0.08] px-4 py-3 text-[13px] text-warning"
        data-testid="shared-answer-unauthorized"
      >
        A megosztott válasz megtekintéséhez jelentkezz be.
        <!-- next= carries this answer's path so LoginPage bounces the
             technician straight back here after login (2026-08-24). -->
        <router-link
          :to="{ path: '/login', query: { next: route.fullPath } }"
          class="ml-2 underline underline-offset-2 font-medium"
        >Bejelentkezés</router-link>
      </div>

      <div
        v-else-if="notFound"
        class="rounded-lg border border-danger/30 bg-danger/[0.08] px-4 py-3 text-[13px] text-danger"
        data-testid="shared-answer-not-found"
      >
        A válasz nem található (törölték, vagy a link elavult).
      </div>

      <template v-else-if="data">
        <header class="space-y-2">
          <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
            Megosztott válasz
          </div>
          <h1 class="text-[20px] md:text-[24px] font-semibold text-text-primary leading-tight" data-testid="shared-answer-q">
            {{ data.q }}
          </h1>
          <div class="flex flex-wrap items-baseline gap-3 text-[11.5px] text-text-muted">
            <span class="font-mono">{{ fmtDate(data.created_at) }}</span>
            <span class="font-mono">{{ data.model }}</span>
            <span class="font-mono">{{ data.iterations }} iteráció</span>
            <span class="font-mono uppercase">{{ data.language }}</span>
          </div>
        </header>

        <article
          class="rounded-2xl border border-shell-message-border bg-shell-message-assistant px-5 py-4 shadow-sm"
          data-testid="shared-answer-body"
        >
          <AgentBody
            :data="{
              answer_id: data.answer_id,
              final_text: data.final_text,
              tool_trace: Array.isArray(data.tool_trace) ? (data.tool_trace as never) : [],
              iterations: data.iterations,
              model: data.model,
              language: data.language as 'hu' | 'en',
              resolved_customer: null,
            }"
          />
        </article>

        <details
          v-if="Array.isArray(data.tool_trace) && (data.tool_trace as unknown[]).length > 0"
          class="text-[12px]"
          data-testid="shared-answer-tools"
          @toggle="(e: Event) => showTools = (e.target as HTMLDetailsElement).open"
        >
          <summary class="cursor-pointer text-text-muted hover:text-text-primary select-none">
            Tool trace ({{ (data.tool_trace as unknown[]).length }})
          </summary>
          <ol class="mt-2 space-y-1 font-mono text-[11px] text-text-secondary">
            <li
              v-for="(t, i) in (data.tool_trace as Array<{ name: string; ok: boolean; note?: string }>)"
              :key="i"
              class="flex items-baseline gap-2"
            >
              <span class="text-nct-soft">{{ t.name }}</span>
              <span v-if="t.ok === true" class="text-success">✓</span>
              <span v-else-if="t.ok === false" class="text-danger">✗</span>
              <span v-if="t.note" class="text-text-muted truncate">{{ t.note }}</span>
            </li>
          </ol>
        </details>
      </template>
    </div>
  </div>
</template>
