// src/lib/errors.ts
//
// Hiba → emberi mondat átalakító az oldal-szintű ErrorState komponensekhez.
// Spec §5.3: a `{error, detail, hint}` JSON-t emberi mondattá alakítja —
// soha nem jelenítünk meg nyers JSON-t a felületen.
//
// Az ApiErrorBody-t fogyasztja, amit a useApi.ts dob (status + body),
// valamint sima Error-okat. Minden felismerhetetlen eset egy általános
// üzenetre esik vissza, ami mindig tartalmaz egy "mit csinálj" tippet.

import type { ApiErrorBody } from './api'

export interface HumanError {
  title: string
  description: string
}

interface WireError {
  error?: string
  detail?: string
  hint?: string
}

function isApiErrorBody(e: unknown): e is ApiErrorBody {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as Record<string, unknown>).status === 'number' &&
    typeof (e as Record<string,unknown>).message === 'string' &&
    'body' in (e as Record<string, unknown>)
  )
}

function getWireError(body: unknown): WireError | null {
  if (typeof body !== 'object' || body === null) return null
  return body as WireError
}

/**
 * Tetszőleges dobott értéket leképez (cím + leírás) párra.
 *
 * Speciális esetek:
 *   - hálózati hiba (status 0)            → "Kapcsolódási hiba"
 *   - `error: "cmms-api unavailable"` (503) → szerver hint szövege
 *   - egyéb 5xx                           → "Szerverhiba (HTTP {status})"
 *   - 4xx                                 → "A kérés elbukott (HTTP {status})"
 */
export function humanizeError(err: unknown): HumanError {
  if (isApiErrorBody(err)) {
    if (err.status === 0) {
      return {
        title: 'Kapcsolódási hiba',
        description: 'A dashboard nem éri el a szervert. Ellenőrizd a hálózatot, majd próbáld újra.',
      }
    }
    const wire = getWireError(err.body)
    if (wire?.error === 'cmms-api unavailable') {
      return {
        title: 'CMMS API nem elérhető',
        description:
          wire.hint ??
          wire.detail ??
          'A CMMS API újratöltődik. Próbáld újra egy perc múlva.',
      }
    }
    if (err.status >= 500) {
      return {
        title: `Szerverhiba (HTTP ${err.status})`,
        description: wire?.detail ?? wire?.hint ?? wire?.error ?? 'Valami elromlott a szerveren. Próbáld újra rövidesen.',
      }
    }
    return {
      title: `A kérés elbukott (HTTP ${err.status})`,
      description: wire?.error ?? wire?.detail ?? wire?.hint ?? 'A szerver elutasította a kérést.',
    }
  }

  if (err instanceof Error && err.message) {
    return {
      title: 'Valami elromlott',
      description: err.message,
    }
  }

  return {
    title: 'Valami elromlott',
    description: 'Váratlan hiba történt. Próbáld újra, vagy töltsd újra az oldalt.',
  }
}
