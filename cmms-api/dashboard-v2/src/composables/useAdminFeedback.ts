// src/composables/useAdminFeedback.ts
//
// Admin-side feedback API client. Distinct from useApi because the
// auth model is different:
//   - useApi uses the read bearer token (sessionStorage).
//   - Admin endpoints require the admin cookie (3-min TTL); the
//     bearer fallback does NOT unlock them (see
//     dashboard/server.ts:175-178). We therefore send `credentials:
//     'same-origin'` and let the cookie ride along, then branch on
//     the 401 to route the admin back to /admin/login.
//
// Endpoints (all admin-only):
//   GET  /dashboard/api/feedback/disliked?limit=&offset=
//   GET  /dashboard/api/feedback/settings
//   POST /dashboard/api/feedback/settings { verbose_dislike }

import type {
  FeedbackCounters,
} from '@/lib/api'
import { getSessionToken } from './useSessionToken'

export interface DislikedItem {
  answer_id: string
  q: string
  final_text: string
  tool_trace: unknown[]
  model: string
  iterations: number
  language: 'hu' | 'en'
  resolved_customer: string | null
  ticket_cards: unknown
  created_at: string
  vote: {
    uid: string
    vote: -1
    reason: string | null
    created_at: string
  }
}

export interface DislikedListResponse {
  items: DislikedItem[]
  total: number
  limit: number
  offset: number
}

export interface FeedbackSettings {
  verbose_dislike: boolean
}

const BASE = '/dashboard/api/feedback'

/**
 * Shared fetch helper. Unlike the useApi helper, this one:
 *   - never sets a bearer token (admin is cookie-only);
 *   - throws a typed `AdminAuthError` on 401 so the caller can
 *     route to /admin/login without coupling to the error body
 *     shape.
 */
class AdminAuthError extends Error {
  constructor() { super('admin_not_authenticated') }
  readonly kind = 'admin_auth' as const
}

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // Admin endpoints are cookie-only. The bearer token is intentionally
  // NOT sent — sending it would 401 (the cmms-api write-gate accepts
  // only the configured write token, which the dashboard doesn't
  // have; the proxy injects it). sessionStorage IS read so a future
  // "admin via bearer" extension can be added without churning callers.
  void getSessionToken()
  let r: Response
  try {
    r = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
  } catch (e) {
    throw {
      status: 0,
      message: 'Network error',
      body: undefined,
      cause: e instanceof Error ? e.message : String(e),
    }
  }
  if (r.status === 401) throw new AdminAuthError()
  if (!r.ok) {
    let body: unknown = undefined
    try { body = await r.json() } catch { /* ignore */ }
    throw { status: r.status, message: `HTTP ${r.status}`, body }
  }
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

export const useAdminFeedback = () => ({
  /** Counter totals (the public ones — admin uses them to fill the
   *  "Aktív visszajelzések" card on the panel). */
  loadFeedbackCounters(): Promise<FeedbackCounters> {
    return adminRequest<FeedbackCounters>(`${BASE}/counters`)
  },

  /** List the most recent disliked answers. */
  loadDisliked(limit = 50, offset = 0): Promise<DislikedListResponse> {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) }).toString()
    return adminRequest<DislikedListResponse>(`${BASE}/disliked?${qs}`)
  },

  /** Read the verbose-dislike flag. */
  loadSettings(): Promise<FeedbackSettings> {
    return adminRequest<FeedbackSettings>(`${BASE}/settings`)
  },

  /** Toggle the verbose-dislike flag. */
  saveSettings(verbose: boolean): Promise<FeedbackSettings> {
    return adminRequest<FeedbackSettings>(`${BASE}/settings`, {
      method: 'POST',
      body: JSON.stringify({ verbose_dislike: verbose }),
    })
  },

  /** Type guard for the 401-from-cookie path. */
  isAdminAuthError(e: unknown): e is AdminAuthError {
    return e instanceof AdminAuthError
  },
})

export { AdminAuthError }
