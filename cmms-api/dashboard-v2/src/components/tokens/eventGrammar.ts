// src/components/tokens/eventGrammar.ts
//
// Phase 5.5 — audit event grammar.
//
// Centralizes the mapping from raw `action` strings (as emitted by the
// server) to a human-readable Hungarian label, a semantic tone (for
// color and icon) and a logical group (auth / activity / token /
// approval / failure).
//
// `group` is what the AuditFilters chips use; `tone` is what the badge
// uses for color. Adding a new event type means appending an entry
// here — no other file needs to change.

import type { AuditAction } from '@/lib/api'

export type EventTone =
  | 'success'   // login / normal completion
  | 'neutral'   // logout, generic access
  | 'info'      // question / answer / informational
  | 'brand'     // token mutation (acquire, rotate)
  | 'warn'      // approvals
  | 'danger'    // failures, denials, reverts

export type EventGroup = 'auth' | 'activity' | 'token' | 'approval' | 'failure' | 'other'

export interface EventGrammar {
  /** Hungarian label, lowercase, fits after the event-icon dot. */
  label: string
  tone: EventTone
  group: EventGroup
  /** Inline-SVG name for EventBadge. Kept short; default icon used if absent. */
  icon?: 'login' | 'logout' | 'question' | 'answer' | 'shield' | 'rotate' | 'ban' | 'info'
}

/**
 * Server action → {label, tone, group, icon}. Order matters: the
 * first match wins. Always add new entries above the catch-all `other`
 * branch.
 */
export const EVENT_GRAMMAR: Record<string, EventGrammar> = {
  login: {
    label: 'bejelentkezés',
    tone: 'success',
    group: 'auth',
    icon: 'login',
  },
  logout: {
    label: 'kijelentkezés',
    tone: 'neutral',
    group: 'auth',
    icon: 'logout',
  },
  login_failed: {
    label: 'sikertelen bejelentkezés',
    tone: 'danger',
    group: 'failure',
    icon: 'ban',
  },
  question: {
    label: 'kérdés',
    tone: 'info',
    group: 'activity',
    icon: 'question',
  },
  answer: {
    label: 'válasz',
    tone: 'info',
    group: 'activity',
    icon: 'answer',
  },
  approval: {
    label: 'jóváhagyás',
    tone: 'warn',
    group: 'approval',
    icon: 'shield',
  },
  acquire_token: {
    label: 'token szerzés',
    tone: 'brand',
    group: 'token',
    icon: 'shield',
  },
  token_rotate_request: {
    label: 'token rotáció kérés',
    tone: 'warn',
    group: 'token',
    icon: 'rotate',
  },
  revert_request: {
    label: 'visszaállítás kérés',
    tone: 'danger',
    group: 'failure',
    icon: 'ban',
  },
}

const FALLBACK: EventGrammar = {
  label: 'egyéb esemény',
  tone: 'neutral',
  group: 'other',
  icon: 'info',
}

/**
 * Look up the grammar entry for an action. Always returns a value —
 * unknown actions fall back to a neutral "egyéb esemény" so the UI
 * never crashes on a server-emitted string we haven't seen yet.
 */
export function getEventGrammar(action: string | AuditAction): EventGrammar {
  return EVENT_GRAMMAR[action] ?? FALLBACK
}

/** All known group ids, in display order. Used by the filter chips. */
export const ALL_GROUPS: { id: EventGroup; label: string }[] = [
  { id: 'auth', label: 'Hitelesítés' },
  { id: 'activity', label: 'Tevékenység' },
  { id: 'token', label: 'Token' },
  { id: 'approval', label: 'Jóváhagyás' },
  { id: 'failure', label: 'Hiba' },
  { id: 'other', label: 'Egyéb' },
]

/**
 * Testable helper: does this action match the active group filter?
 * `null` filter means "all groups".
 */
export function matchesGroup(
  action: string | AuditAction,
  group: EventGroup | null,
): boolean {
  if (group === null) return true
  return getEventGrammar(action).group === group
}
