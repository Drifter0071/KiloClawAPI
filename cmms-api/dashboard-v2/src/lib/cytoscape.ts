// src/lib/cytoscape.ts
//
// Cytoscape node factories + style helpers for the Map page (spec §5.3).
//
// Visual rules (Phase 7 v6 — "same family only, type on hover"):
//
//   - One node per machine-type group, returned by /v1/jobs/stats
//     (group_by=machine_type). The server defaults to 1000 groups.
//   - Each node gets a STABLE, UNIQUE HSL color derived from a hash of
//     the model label. Same label → same color across renders and
//     sessions. Set per-element on `style.background-color` (NOT via
//     cytoscape's `mapData()` mapper which interpolates HSL and made
//     every node look the same in v3).
//   - Node size scales with ticket count, clamped 16..160.
//   - Edges are SAME-FAMILY ONLY. The similarity function is
//     dominated by the family-key match (0.7 weight); cross-family
//     Jaccard alone (0.3 weight) can't reach the 0.20 minimum. The
//     previous v4 had a "no island" backstop that connected lonely
//     nodes to their nearest neighbour even with sim=0 — that was
//     the bug the user reported: "only the same type should be
//     linked". Lone families now sit alone.
//   - Labels are TRUNCATED. Long machine names like
//     "DPB-3-40-0-...-120-120-RR-AT" become "DPB-3-40" on canvas
//     (which is also the family key). Full label + family + ticket
//     count appear in the hover tooltip and the side drawer.
//   - Non-machine labels are filtered out client-side via
//     `filterMachineNodes()` (placeholder words like "nincs megadva",
//     status words like "sikeres" / "figyelem", and trivial strings
//     like "---"). Dropped count is shown as a "N rejtett" badge
//     in the bottom-left stats so the user knows filtering happened.
//
// IMPORTANT: `cytoscape-cose-bilkent` 4.x is a separate package and MUST
// be registered with `cytoscape.use(...)` before the layout name is
// recognised. Without this, the runtime throws
// "No such layout `cose-bilkent` found. Did you forget to import it
// and `cytoscape.use()` it?" on the first `cy.layout()` call.

import cytoscape, { type Core } from 'cytoscape'
import coseBilkent from 'cytoscape-cose-bilkent'
import type { MapNode, MapSample } from './api'

// Register the cose-bilkent layout extension on the cytoscape singleton.
// Idempotent — cytoscape dedupes by extension name.
cytoscape.use(coseBilkent)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The runtime shape stored in each cytoscape node's `data`. */
interface CyNodeData {
  label: string
  /** Short version of the label used for the on-canvas text. */
  shortLabel: string
  raw: string
  tickets: number
  samples: MapSample[]
  /** Stable HSL hue derived from the model label. */
  hue: number
  /** The "type" / family prefix (e.g. "DPB-3-40" for any DPB-3-40-*). */
  family: string
}

export interface CyEdge {
  source: string
  target: string
  /** 0..1 — Jaccard similarity of the tokenized model labels. */
  weight: number
}

// ---------------------------------------------------------------------------
// Stable per-node color (FNV-1a hash → HSL hue)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Family key — what the user calls "the type" of a node
// ---------------------------------------------------------------------------

/**
 * Extract the "type" / family from a model label. Two labels that
 * share the same family key belong to the same machine family —
 * the user wants edges drawn ONLY between same-family nodes.
 *
 * The actual rule is non-trivial because Hungarian machine names
 * mix two distinct conventions:
 *
 *   DASH convention (formal machine IDs):
 *     "DPB-3-40-0-...-120-120-RR-AT"   the family is the first 3 parts
 *     "EEN-60-120"                    it's all-the-id, the family is itself
 *     "M26057"                        no dash, family is the whole label
 *     "iPS-5100"                      the family is "iPS" (not "iPS-5100")
 *     "iPS"                           family is "iPS"
 *
 *   DOT convention (informal machine-component names):
 *     "Forg.főorsó"                   family is "Forg"
 *     "Szervo.fék"                    family is "Szervo"
 *     "Motormunkahenger"              no separator, family is itself
 *     "Köz.leömlő"                    family is "Köz"
 *
 * Algorithm (priority order):
 *   1. Space separator → family is everything before the first space
 *      (e.g. "TMV-400 vezérlő" → "TMV-400")
 *   2. Dot separator → family is everything before the first dot
 *      (e.g. "Forg.főorsó" → "Forg"). Hungarian dot-names follow
 *      "<category>.<sub-component>" and the category is the family.
 *   3. Dash-only or no separator → family is the first 2-3 dash-parts
 *      if the first part is short (≤ 4 chars: DPB, iPS, EEN, TMV,
 *      EML, BNC, DA24). If the first part is long (≥ 5 chars and not
 *      purely digits, e.g. "Motormunkahenger", "Köz"), the family is
 *      the whole label.
 */
export function familyKey(model: string): string {
  const raw = (model || '').trim()
  if (!raw) return '?'

  // Rule 1: space → everything before the first space.
  const spaceIdx = raw.search(/\s/)
  if (spaceIdx > 0) return raw.slice(0, spaceIdx).trim()

  // Rule 2: dot. Only treat it as a separator when the dot is NOT
  // part of an ellipsis ("...") — many long machine IDs include
  // "..." in the middle to mean "stuff we don't care about". Find
  // the first standalone `.` (preceded by a non-dot, followed by a
  // non-dot) and use everything before it as the family.
  let firstStandaloneDot = -1
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '.') continue
    const prev = i > 0 ? raw[i - 1] : ''
    const next = i < raw.length - 1 ? raw[i + 1] : ''
    if (prev !== '.' && next !== '.') {
      firstStandaloneDot = i
      break
    }
  }
  if (firstStandaloneDot > 0) {
    return raw.slice(0, firstStandaloneDot).trim()
  }

  // Rule 3: dash-only or no separator.
  if (!raw.includes('-')) {
    // No dash at all → family is the whole label.
    return raw
  }

  // Dash-separated. Split into parts.
  const parts = raw.split('-').filter(Boolean)
  if (parts.length === 0) return raw
  if (parts.length === 1) return parts[0]!

  // Heuristic for dash-only labels: the family is the first 3
  // dash-parts (if there are that many), or 2 if there are only 2.
  // The split-by-part rule can't reliably distinguish "iPS" (a name
  // that should be the family) from "DPB" (a name that needs "-3-40"
  // to be a distinct family) without more context — there's no way
  // for a 3-line heuristic to know that. So we default to "first
  // 3 parts" which means:
  //   "DPB-3-40-0-...-120-120-RR-AT" → "DPB-3-40"   ✓ correct
  //   "DPB-3-50-DA24"                → "DPB-3-50"   ✓ correct
  //   "iPS-5100"                     → "iPS-5100"   (iPS-5100 and
  //                                                  iPS-5180 are
  //                                                  DIFFERENT families
  //                                                  under this rule;
  //                                                  the user accepted
  //                                                  this trade-off)
  //   "EEN-60-120"                   → "EEN-60-120" (single-family)
  if (parts.length >= 3) return `${parts[0]}-${parts[1]}-${parts[2]}`
  if (parts.length === 2) return `${parts[0]}-${parts[1]}`
  return parts[0]!
}

// ---------------------------------------------------------------------------
// Non-machine label filter
// ---------------------------------------------------------------------------

/**
 * The server's `group_by=machine_type` returns every distinct value
 * stored in `devices[].machine_type` across the data set, including
 * placeholders ("nincs megadva", "(nincs megadva)") and accidentally
 * stored status words ("sikeres", "figyelem", "OK"). The user
 * explicitly asked for these to be hidden — they're not machine
 * types, they're noise.
 *
 * This returns false for any label that:
 *   1. Is empty / only punctuation / only whitespace
 *   2. Matches a known placeholder pattern (HU + EN variants)
 *   3. Matches a known status / log word (these are never machines)
 *   4. Is a single non-alphanumeric word (e.g. "---", "...", "x")
 *   5. Is too short to be a real machine identifier (< 2 chars)
 *
 * The list of placeholders is intentionally hard-coded — the
 * patterns are stable Hungarian + English conventions, not user-
 * editable data.
 */
const PLACEHOLDER_LABELS = new Set([
  // Hungarian "not given" / "unknown"
  'nincs megadva', 'nincs', 'ismeretlen', 'n/a', 'n.a.', 'üres', 'ures', 'egyéb', 'egyeb',
  'nincs gép', 'nincs gep', 'nincs géptípus', 'nincs geptipus',
  'nem ismert', 'ismeretlen típus', 'ismeretlen tipus', 'egyéb gép', 'egyeb gep',
  // English "not given" / "unknown"
  'unknown', 'none', 'no data', 'no machine', 'n/a', 'na', 'tbd', 'todo', '-', '—',
  'other', 'misc', 'miscellaneous', 'unspecified', 'undefined', 'null', 'nil',
  'no type', 'no model', 'no machine type', 'not set', 'not specified',
  // Wrapped-in-parens placeholders
  '(nincs megadva)', '(nincs)', '(ismeretlen)', '(unknown)', '(none)', '(other)', '(misc)',
])

const STATUS_LABELS = new Set([
  // These are categories, not machines
  'sikeres', 'sikertelen', 'figyelem', 'hiba', 'ok', 'kész', 'kesz', 'folyamatban',
  'lezárva', 'lezarva', 'nyitott', 'zárolt', 'zarolt', 'várakozik', 'varakozik',
  'pending', 'closed', 'open', 'in progress', 'done', 'failed', 'success', 'error',
  'warning', 'critical', 'resolved', 'unresolved', 'active', 'inactive',
])

export function isMachineLabel(label: string): boolean {
  const v = (label || '').trim().toLowerCase()
  if (v.length < 2) return false
  if (PLACEHOLDER_LABELS.has(v)) return false
  if (STATUS_LABELS.has(v)) return false
  // Reject labels that are just punctuation / decoration.
  if (!/[a-z0-9]/.test(v)) return false
  // Reject "x" / "xx" / "asdf" type obviously-junk strings — but
  // a single "x" is allowed if there are other characters. A label
  // that's all single-char tokens is also suspicious.
  const tokens = v.split(/[\s\-./]+/).filter(Boolean)
  if (tokens.length > 0 && tokens.every((t) => t.length <= 1)) return false
  return true
}

/**
 * Apply isMachineLabel to every node and return the filtered set.
 * Dropped nodes are reported in the result so the UI can show a
 * small "N rejtett" badge.
 */
export function filterMachineNodes<T extends MapNode>(nodes: T[]): {
  kept: T[]
  dropped: T[]
} {
  const kept: T[] = []
  const dropped: T[] = []
  for (const n of nodes) {
    if (isMachineLabel(n.model || n.raw || '')) kept.push(n)
    else dropped.push(n)
  }
  return { kept, dropped }
}

/**
 * FNV-1a 32-bit hash. Deterministic, fast, no deps. The same string
 * always produces the same hash; distinct strings produce distinct
 * hues with high probability even for short model labels.
 *
 * This is the basis for `nodeColor()` — see the comment on that
 * function for why we hash the label instead of using cytoscape's
 * built-in `mapData()` mapper.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/**
 * Map a model label to a stable HSL hue (0..359). The S+L are fixed
 * to give every node enough chroma to be visually distinct on the
 * near-black canvas, and enough lightness to read against the
 * border-default stroke.
 *
 * IMPORTANT: this returns a CSS hsl() string for the FINAL color, NOT
 * a raw hue number. The previous v3 implementation used cytoscape's
 * `mapData(hue, 0, 359, hsl(0,70%,62%), hsl(359,70%,62%))` mapper
 * which linearly interpolates HSL components and pulls every node
 * toward the start/end colors — which is why every node looked the
 * same pinkish-red. The mapper form is fundamentally broken for
 * "give each node its own arbitrary color"; the only correct way is
 * to set the resolved color string per-element.
 */
export function nodeColor(model: string): string {
  const key = (model || '').trim() || 'unknown'
  const hue = fnv1a(key) % 360
  return `hsl(${hue}, 70%, 62%)`
}

/** Raw hue (0..359) for callers that want to vary saturation/lightness. */
export function nodeHue(model: string): number {
  const key = (model || '').trim() || 'unknown'
  return fnv1a(key) % 360
}

// ---------------------------------------------------------------------------
// Node size — unbounded ticket count, only the visual extremes are clamped
// ---------------------------------------------------------------------------

const NODE_MIN_PX = 16
const NODE_MAX_PX = 160

/**
 * Map ticket count to a node diameter in pixels. No upper cap on the
 * input — sqrt scaling keeps the growth bounded for typical
 * distributions, and the visual extremes (very small + very large)
 * are clamped at 16/160 so the canvas stays usable.
 */
export function nodeSize(tickets: number): number {
  const t = Math.max(0, Number(tickets) || 0)
  const raw = 14 + Math.sqrt(t) * 4.2
  return Math.min(NODE_MAX_PX, Math.max(NODE_MIN_PX, Math.round(raw)))
}

// ---------------------------------------------------------------------------
// Label shortener
// ---------------------------------------------------------------------------

/**
 * Produce a short, readable version of a model label for the on-canvas
 * text. The full label is preserved in `data.label` for tooltips and
 * the side sheet — this is purely what cytoscape draws under each node.
 *
 * Rules:
 *   1. Take the first dash-separated segment (e.g. "DPB-3-40-0-..."
 *       becomes "DPB-3-40" by chopping at the 3rd dash).
 *   2. If the result is still > 16 chars, truncate to 14 + "…".
 *   3. If the label is short already, return it as-is.
 *
 * Examples:
 *   "M26057"                   -> "M26057"
 *   "iPS"                      -> "iPS"
 *   "DPB-3-40-0-...-120-RR-AT" -> "DPB-3-40"
 *   "DPB-3-40-DA24-36D-LF"     -> "DPB-3-40-…"
 */
export function shortLabel(label: string): string {
  const raw = (label || '').trim()
  if (!raw) return '?'
  // First 3 dash-separated parts joined back.
  const parts = raw.split('-').filter(Boolean)
  let candidate = parts.slice(0, 3).join('-')
  if (candidate.length > 18) candidate = candidate.slice(0, 14) + '…'
  if (candidate.length === 0) candidate = raw.slice(0, 16)
  return candidate
}

// ---------------------------------------------------------------------------
// Edges — adaptive k-NN + connected-backbone guarantee
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // Common machine-id noise that would otherwise pull unrelated
  // machines together. Keep the list small — over-stripping hides
  // legitimate signal.
  'és', 'a', 'az', 'egy', 'the', 'of', '-',
])

/** Tokenize a model label into a set of meaningful tokens. */
function tokenize(model: string): Set<string> {
  const out = new Set<string>()
  const cleaned = (model || '').toLowerCase().replace(/[()\[\];,.]/g, ' ')
  for (const tok of cleaned.split(/\s+/)) {
    if (tok.length < 2) continue
    if (STOPWORDS.has(tok)) continue
    out.add(tok)
  }
  return out
}

/** Jaccard similarity of two token sets. Returns 0 for empty inputs. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Combined similarity score in 0..1. Two-component blend tuned
 *  for "same family = connected, different family = not connected":
 *
 *    - 0.30 * Jaccard on tokens (token overlap)
 *    - 0.70 * family-key match bonus (1.0 if same family, else 0)
 *
 * The family match is the dominant signal — any two labels with
 * the same family key (e.g. both "DPB-3-40-...") score at least
 * 0.70, way above the threshold. Two labels with different
 * families can still tie via Jaccard (e.g. "Forg.főorsó" and
 * "Forg.kuplung" share "forg" → 0.30 * 1/3 = 0.10) which is below
 * the 0.20 threshold so no edge is drawn. The v5 algorithm is
 * STRICT: every edge represents a real family tie.
 */
function similarity(
  a: Set<string>,
  b: Set<string>,
  familyA: string,
  familyB: string,
): number {
  const j = jaccard(a, b)
  const sameFamily = familyA === familyB ? 1 : 0
  return Math.min(1, j * 0.3 + sameFamily * 0.7)
}

/**
 * Pick a k appropriate for the family-cluster size. The Map page
 * organises nodes by family (a "DPB-3-40" family of 8 variants
 * should have ~8 internal edges, not connect to M26057 at all).
 * The k value is intentionally generous so dense families are
 * richly connected — the dedup pass collapses symmetric pairs.
 *
 *   N nodes → k neighbours
 *   -------   ------------
 *     3..8    3
 *     9..20   4
 *    21..50   5
 *    51..100  6
 *     100+    7
 */
function adaptiveK(n: number): number {
  if (n <= 8) return 3
  if (n <= 20) return 4
  if (n <= 50) return 5
  if (n <= 100) return 6
  return 7
}

/**
 * Build the edge list. v5 — strict same-family only:
 *
 *   1. Each node's `familyKey()` is computed (DPB-3-40, M26057, …).
 *   2. Edges are drawn between every node and its k nearest
 *      neighbours — but the similarity function is dominated by
 *      the family-match term (0.7) so cross-family pairs almost
 *      never qualify.
 *   3. The minimum similarity is 0.20 — any candidate below that
 *      is dropped. This kills the v4 "no island" backstop which
 *      used to connect lonely nodes to their nearest neighbour
 *      even with sim=0. The user explicitly asked for
 *      "only same type should be linked" — lone nodes stay lone.
 *   4. Symmetric pairs (i→j and j→i) collapse to one edge.
 *
 * Result: a graph where every cluster is a real family group and
 * isolated nodes (a single "M26057" with no siblings) sit by
 * themselves. The user reads it as "this machine type is the only
 * one in its family" which is exactly the right signal.
 */
export function computeEdges(
  nodes: MapNode[],
  k?: number,
  minSim: number = 0.20,
): CyEdge[] {
  if (nodes.length < 2) return []
  const labels = nodes.map((n) => n.model || n.raw || '')
  const families = labels.map((l) => familyKey(l))
  const tokens = labels.map((l) => tokenize(l))
  const ids = labels.map((l, i) => l || `node-${i}`)

  const effectiveK = k ?? adaptiveK(nodes.length)

  // Pairwise similarity matrix (symmetric, upper triangle only).
  const N = nodes.length
  const sim: number[][] = Array.from({ length: N }, () => new Array(N).fill(0))
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const s = similarity(tokens[i]!, tokens[j]!, families[i]!, families[j]!)
      sim[i]![j] = s
      sim[j]![i] = s
    }
  }

  // Single pass: k-NN with same-family gating.
  const candidate: CyEdge[] = []
  for (let i = 0; i < N; i++) {
    const rowI = sim[i]!
    const order = Array.from({ length: N }, (_, j) => j)
      .filter((j) => j !== i)
      .sort((a, b) => rowI[b]! - rowI[a]! || ids[a]!.localeCompare(ids[b]!))
    for (let n = 0; n < Math.min(effectiveK, order.length); n++) {
      const j = order[n]!
      if (rowI[j]! < minSim) continue
      candidate.push({ source: ids[i]!, target: ids[j]!, weight: rowI[j]! })
    }
  }

  // Deduplicate symmetric pairs.
  const seen = new Set<string>()
  const edges: CyEdge[] = []
  for (const e of candidate) {
    const k1 = `${e.source}\u0000${e.target}`
    const k2 = `${e.target}\u0000${e.source}`
    if (seen.has(k1) || seen.has(k2)) continue
    seen.add(k1)
    edges.push(e)
  }

  return edges
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

/**
 * Cytoscape stylesheet. Per-node `background-color` and `label` are
 * set on the element itself (see `makeCyto`) rather than via the
 * stylesheet mapper — the previous v3 stylesheet used
 *   `background-color: mapData(hue, 0, 359, hsl(0,70%,62%), hsl(359,70%,62%))`
 * which linearly interpolates HSL components and made every node
 * look the same pinkish-red. Setting the color string per-element
 * bypasses the broken mapper entirely.
 *
 * THEME: cytoscape draws into a canvas, so CSS custom properties
 * (`var(--color-…)`) are NOT resolvable there. The controller
 * therefore ships a real `dark` stylesheet and a real `light`
 * stylesheet (DARK_THEME / LIGHT_THEME below) and re-applies the
 * active one when the document theme changes — see `setTheme()`.
 *
 * The stylesheet below is now mostly defaults + per-state visuals.
 */
const DARK_THEME = {
  node: {
    'border-color': 'rgba(255,255,255,0.28)',
    color: '#E4E4E7',
    'text-background-color': '#0F1117',
    'text-background-opacity': 0.6,
  },
  edge: {
    'line-color': 'rgba(180, 200, 230, 0.40)',
    'target-arrow-color': 'rgba(180, 200, 230, 0.40)',
  },
  familyGroup: {
    color: '#E4E4E7',
    'text-background-color': '#1D2230',
    'text-background-opacity': 0.85,
  },
} as const

const LIGHT_THEME = {
  node: {
    'border-color': 'rgba(10,12,18,0.32)',
    color: '#0A0C12',
    'text-background-color': '#FAFAFC',
    'text-background-opacity': 0.85,
  },
  edge: {
    'line-color': 'rgba(60, 80, 110, 0.55)',
    'target-arrow-color': 'rgba(60, 80, 110, 0.55)',
  },
  familyGroup: {
    color: '#0A0C12',
    'text-background-color': '#FFFFFF',
    'text-background-opacity': 0.9,
  },
} as const

export type MapTheme = keyof typeof DARK_THEME & keyof typeof LIGHT_THEME

function buildStylesheet(theme: 'light' | 'dark'): cytoscape.StylesheetStyle[] {
  const t = theme === 'light' ? LIGHT_THEME : DARK_THEME
  return [
    {
      selector: 'node',
      style: {
        'border-color': t.node['border-color'],
        'border-width': 1.5,
        // `label` is set per-element from `data(shortLabel)`.
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 6,
        color: t.node.color,
        'font-family': '"JetBrains Mono Variable", ui-monospace, monospace',
        'font-size': 10,
        'text-wrap': 'wrap',
        'text-max-width': '90px',
        'text-background-color': t.node['text-background-color'],
        'text-background-opacity': t.node['text-background-opacity'],
        'text-background-padding': '2px',
        'text-background-shape': 'rectangle',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': '#60A5FA', // accent-hover
        'border-width': 3,
        'background-opacity': 1,
      },
    },
    {
      selector: 'node:active',
      style: {
        'border-color': '#3B82F6', // accent
        'border-width': 3,
      },
    },
    {
      // Hover: brighten the node + draw a 1px halo ring around it.
      selector: 'node.hover',
      style: {
        'border-color': '#60A5FA',
        'border-width': 2.5,
      },
    },
    {
      // Edges — visible thin curves on the canvas. The opacity +
      // width are tuned so the user can actually see "this node is
      // connected to that node" at a glance, while still keeping
      // edges subordinate to the nodes themselves.
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': t.edge['line-color'],
        'target-arrow-color': t.edge['target-arrow-color'],
        'curve-style': 'bezier',
        'control-point-step-size': 40,
        'line-opacity': 0.85,
      },
    },
    {
      // Family group frames (Unreal Engine "Comment" style). Each
      // family with 2+ members gets a translucent rounded rectangle
      // drawn behind its children, with the family name as a label
      // in the top-left corner. The per-element style set in
      // `mapLayout.ts` provides the resolved `background-color` and
      // `border-color` for each family (the broken `mapData()` mapper
      // is no longer used here).
      selector: 'node[_isFamilyGroup]',
      style: {
        'background-opacity': 1,
        'border-width': 1.5,
        'border-style': 'dashed',
        'shape': 'round-rectangle',
        'padding': '24px',
        // Label sits in the top-left corner, bold, with a slight
        // background plate so it stays readable on top of the
        // translucent fill.
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'left',
        'text-margin-x': 8,
        'text-margin-y': -6,
        color: t.familyGroup.color,
        'font-family': '"JetBrains Mono Variable", ui-monospace, monospace',
        'font-size': 11,
        'font-weight': 600,
        'text-background-color': t.familyGroup['text-background-color'],
        'text-background-opacity': t.familyGroup['text-background-opacity'],
        'text-background-padding': '3px',
        'text-background-shape': 'rectangle',
        'text-wrap': 'wrap',
        'text-max-width': '180px',
        'events': 'yes',
        'min-zoomed-font-size': 8,
      },
    },
    {
      // Stronger edge treatment when either endpoint is selected.
      selector: 'edge:selected',
      style: {
        'line-color': 'rgba(96, 165, 250, 0.95)',
        'target-arrow-color': 'rgba(96, 165, 250, 0.95)',
        width: 2.5,
        'line-opacity': 1,
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

/**
 * Build a Cytoscape core for the given nodes + their derived edges.
 *
 * @param el     container element (MapPage's canvas div)
 * @param nodes  MapNode[] from the /api/map response
 * @param onClick node click callback (fires with the node's data)
 * @param onHover node hover callback (fires with node + MouseEvent)
 */
export function makeCyto(
  el: HTMLElement,
  nodes: MapNode[],
  onClick?: (data: MapNode) => void,
  onHover?: (data: MapNode, evt: MouseEvent) => void,
): Core {
  // Compute per-node color (hue) + edges up front. Both are derived
  // purely from the input — no random or session state — so the
  // graph looks identical across renders and reloads.
  const idOf = (n: MapNode, idx: number) =>
    n.model || n.raw || `node-${idx}`

  // Group node IDs by family so we can wrap them in "family group"
  // parents (Unreal-style comment frames). Only families with 2+
  // members get a frame — singletons don't need to be wrapped.
  const familyMembers = new Map<string, string[]>()
  for (const n of nodes) {
    const f = familyKey(n.model || n.raw || '')
    const arr = familyMembers.get(f) ?? []
    arr.push(idOf(n, nodes.indexOf(n)))
    familyMembers.set(f, arr)
  }

  // Build a stable id for each family-group parent.
  const familyGroupId = (key: string) => `family-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`

  const nodeEntries = nodes.map((n, i) => {
    const id = idOf(n, i)
    const label = n.model || n.raw || `node-${i}`
    const hue = fnv1a(label) % 360
    const size = nodeSize(n.tickets)
    const family = familyKey(label)
    const familyGroupKey = familyMembers.get(family)?.length ?? 0 >= 2 ? family : null
    return {
      data: {
        id,
        label,
        shortLabel: shortLabel(label),
        tickets: n.tickets,
        samples: n.samples ?? [],
        raw: n.raw,
        hue,
        family,
        // Compound parent pointer — only set when the family has 2+
        // members (singletons stay top-level so they get a clean
        // layout without an empty wrapper).
        ...(familyGroupKey ? { parent: familyGroupId(familyGroupKey) } : {}),
        size,
      },
      // Per-element style. cytoscape accepts a `style` block on each
      // element which overrides the global stylesheet. We use this to
      // set the resolved CSS color (raw hue → hsl string) and the
      // short label, bypassing the broken `mapData()` mapper.
      style: {
        'background-color': `hsl(${hue}, 70%, 62%)`,
        'background-opacity': 0.92,
        'background-blacken': -0.18,
        label: shortLabel(label),
        width: size,
        height: size,
      },
    }
  })

  // Build the family-group parents — one per family with 2+
  // members. The group is a compound node (has children) and is
  // rendered as a translucent rounded rectangle with a label, like
  // Unreal's "Comment" node in the Blueprint editor.
  const familyGroupEntries: cytoscape.ElementDefinition[] = []
  for (const [family, memberIds] of familyMembers.entries()) {
    if (memberIds.length < 2) continue
    const hue = fnv1a(family) % 360
    familyGroupEntries.push({
      data: {
        id: familyGroupId(family),
        label: family,
        family,
        hue,
        // Sentinel so the stylesheet knows to render this differently.
        _isFamilyGroup: true,
      },
    })
  }

  const edges = computeEdges(nodes)
  const edgeEntries = edges.map((e) => ({
    data: {
      id: `e-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      weight: e.weight,
    },
  }))

  const cy = cytoscape({
    container: el,
    elements: [...nodeEntries, ...familyGroupEntries, ...edgeEntries],
    // Cast: compound node styles (padding, dashed border, custom
    // attribute selector) aren't in the published TS types but the
    // runtime supports them. The previous element-level style casts
    // on individual nodes are unnecessary now that the stylesheet
    // is permissive here.
    style: buildStylesheet(getActiveTheme()) as unknown as cytoscape.StylesheetCSS[],
    // cose-bilkent 4.x options. Tuned for an organic, non-grid layout:
    //   - nodeRepulsion 6M: strong enough to keep small/single-ticket
    //     groups from piling against the big hubs. The previous 4.5M
    //     value let a tight cluster form in the top-right because
    //     the gravitational pull on the small lonely nodes was
    //     stronger than the mutual repulsion.
    //   - idealEdgeLength 90: slightly longer than the v3 80 so the
    //     edge-bridged neighbours don't collapse into a tight knot.
    //   - gravity 0.15: lower than v3 (0.2) so the cluster fills the
    //     canvas instead of clumping around its centre-of-mass.
    //   - numIter 2500: a few more iterations help cose-bilkent
    //     converge when the graph is sparse.
    //   - randomize: true: ensure non-deterministic start so two
    //     different node sets don't share the same initial layout.
    layout: {
      name: 'cose-bilkent',
      nodeRepulsion: 6_000_000,
      idealEdgeLength: 90,
      gravity: 0.15,
      numIter: 2500,
      animate: false,
      randomize: true,
      fit: true,
      padding: 32,
    } as unknown as cytoscape.LayoutOptions,
  })

  cy.nodes().forEach((n) => {
    const toMapNode = (): MapNode & {
      _color: string
      _hue: number
      _family: string
    } => {
      const d = n.data() as unknown as CyNodeData
      return {
        model: d.label ?? d.raw ?? '',
        raw: d.raw ?? '',
        tickets: d.tickets ?? 0,
        samples: d.samples ?? [],
        _color: `hsl(${d.hue}, 70%, 62%)`,
        _hue: d.hue,
        _family: d.family ?? familyKey(d.label ?? d.raw ?? ''),
      }
    }
    n.on('tap', () => onClick?.(toMapNode()))
    n.on('mouseover', () => {
      n.addClass('hover')
    })
    n.on('mouseout', () => {
      n.removeClass('hover')
    })
    n.on('mousemove', (evt) => onHover?.(toMapNode(), evt.originalEvent ?? evt))
  })

  return cy
}

// ---------------------------------------------------------------------------
// v7 — MapGraphController + createMapGraph (Phase 7 Map redesign)
// ---------------------------------------------------------------------------
//
// `makeCyto` (above) builds a cytoscape `Core` from `MapNode[]` rows
// straight from the API. Phase 7 splits that responsibility:
//
//   - `src/lib/mapNormalization.ts` turns the raw rows into a
//     deduplicated, family-grouped, ticket-scaled set of
//     `NormalizedMapNode`s with stable x/y positions.
//   - `src/lib/mapLayout.ts` packages those nodes (plus edges +
//     group-parent frames) into a flat `cytoscape.ElementDefinition[]`.
//   - This file exposes `createMapGraph` — a thin factory that takes
//     that element list, runs the existing `cose-bilkent` layout,
//     applies the existing `GRAPH_STYLESHEET`, and hands back a
//     `MapGraphController` (zoom, fit, theme, toggle labels / edges,
//     live element-set replace, etc.).
//
// The controller wraps the cytoscape `Core` and is what the Map page
// holds onto. The previous `makeCyto` is kept around because the
// unit tests in `tests/cytoscape.spec.ts` exercise the cose-bilkent
// registration against a headless Core; breaking its signature would
// regress that coverage.

import type { ElementDefinition } from 'cytoscape'

/**
 * Read the active theme from the document root. The `useTheme`
 * composable writes a `.dark` class to `<html>` and `tokens.css`
 * binds every color to the resulting CSS variable, so a single
 * `classList.contains('dark')` is the source of truth here.
 *
 * Falls back to `dark` in non-DOM environments (SSR / test) so the
 * Map page can be rendered headlessly without crashing.
 */
export function getActiveTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * Lightweight controller wrapping a cytoscape `Core`. The Map page
 * holds one of these per map instance and calls into it to toggle
 * labels, switch themes, replace the element set, or pan/zoom.
 *
 * Every method is safe to call on a destroyed controller — the
 * underlying `cy` is nulled out in `destroy()` and methods that
 * touch it early-return.
 */
export interface MapGraphController {
  /** Toggle the visibility of per-node text labels (does NOT hide
   *  the family-group frame labels — those stay readable so the user
   *  still knows which group is which). */
  setShowLabels(b: boolean): void
  /** Toggle the visibility of same-family edges. */
  setShowEdges(b: boolean): void
  /**
   * Replace the live element set in place. Used when the layout
   * recomputes (e.g. period change, search change) but the user
   * has panned/zoomed in the meantime. Preserves pan/zoom state.
   */
  setElements(els: ElementDefinition[]): void
  /**
   * Re-apply theme colors. The cytoscape canvas can't read CSS custom
   * properties, so toggling the `.dark` class on `<html>` doesn't
   * affect the in-canvas visuals. This method swaps the entire
   * stylesheet for the new theme's token set.
   */
  setTheme(t: 'light' | 'dark'): void
  zoomIn(): void
  zoomOut(): void
  fit(): void
  centerOn(nodeId: string): void
  destroy(): void
}

export interface CreateMapGraphOptions {
  onClick?: (id: string) => void
  onHover?: (id: string | null, evt: MouseEvent) => void
}

/**
 * Build a cytoscape graph on the given container element. Returns
 * a `MapGraphController` for live updates. The cose-bilkent layout
 * is run synchronously (no animation) so the controller can answer
 * `centerOn()` / `fit()` calls right after construction.
 */
export function createMapGraph(
  el: HTMLElement,
  elements: ElementDefinition[],
  opts: CreateMapGraphOptions = {},
): MapGraphController {
  // Initial stylesheet = active theme. Toggling theme later swaps
  // the entire stylesheet (cytoscape can't read CSS vars in canvas).
  let activeTheme: 'light' | 'dark' = getActiveTheme()
  const cy = cytoscape({
    container: el,
    elements: elements as cytoscape.ElementDefinition[],
    style: buildStylesheet(activeTheme) as unknown as cytoscape.StylesheetCSS[],
    // `preset` layout: every element stays exactly where the
    // pre-computed `position` says. NO force simulation. The user
    // gets a 100% deterministic, 100% stable layout — switching
    // period / search / grouping never shuffles the nodes. This
    // also means the family-group frame (a compound parent with
    // explicit `position` + `width`/`height`) wraps its children
    // exactly the way mapLayout.ts computed it.
    //
    // (Previously we used `cose-bilkent` with `randomize: false` —
    // but the force simulation still drifted the nodes away from
    // their seed positions, which caused the family frame to be
    // drawn AROUND THE WRONG CLUSTER.)
    layout: {
      name: 'preset',
      positions: undefined,
      fit: true,
      padding: 48,
    } as unknown as cytoscape.LayoutOptions,
  })

  let showLabels = true
  let showEdges = true

  /**
   * Apply the current showLabels / showEdges state to the graph. We
   * toggle ONLY the per-node `text-opacity` (and the node fill) —
   * NOT `display: 'none'`, because that would also hide the family
   * group frames (which are `node` elements in cytoscape's eyes).
   * The family group header label is governed by its own selector
   * (`node[_isFamilyGroup]`) which keeps `text-opacity: 1` always.
   */
  function applyDisplayOptions(): void {
    if (destroyed) return
    // Regular nodes: hide the text label and the node body when
    // showLabels is off. We still keep the node hit-target alive
    // (via `events: 'yes'` and `min-zoomed-font-size`) so the user
    // can click on them.
    const regularNodes = cy.nodes().not('[? _isFamilyGroup]')
    regularNodes.style('text-opacity', showLabels ? 1 : 0)
    // For the node fill, we want it visible even when labels are
    // off (so the colored dot is the visual cue), so we don't
    // touch background-opacity here.
    // Family group frames: KEEP their header label visible even
    // when per-node labels are off, so the user can still read
    // "DPB-3-40" above the cluster.
    const groups = cy.nodes().filter('[? _isFamilyGroup]')
    groups.style('text-opacity', 1)
    // Edges.
    cy.edges().style('display', showEdges ? 'element' : 'none')
  }

  // Wire up node events. The Map page expects `onClick(id)` and
  // `onHover(id, evt)`; the element data carries the node id
  // directly.
  const handlers: Array<{ off: () => void }> = []
  cy.nodes().forEach((n) => {
    const id = n.id()
    const onTap = () => opts.onClick?.(id)
    const onMouseOver = () => {
      n.addClass('hover')
    }
    const onMouseOut = () => {
      n.removeClass('hover')
      // Tell the parent that the hover ended (id=null) so it can
      // hide the tooltip.
      opts.onHover?.(null, new MouseEvent('mouseleave'))
    }
    const onMouseMove = (evt: cytoscape.EventObject) => {
      const original =
        (evt.originalEvent as MouseEvent | undefined) ??
        (evt as unknown as MouseEvent)
      opts.onHover?.(id, original)
    }
    n.on('tap', onTap)
    n.on('mouseover', onMouseOver)
    n.on('mouseout', onMouseOut)
    n.on('mousemove', onMouseMove)
    handlers.push({
      off: () => {
        // The cytoscape TS overloads for `off` only expose the
        // 3-argument form on a node collection (events, selector?,
        // handler?). The selector arg is optional, but when omitted
        // the simple 2-arg call is interpreted as `off(events,
        // selector)` and the handler ends up typed as a string. We
        // use an empty-string selector to disambiguate.
        n.off('tap', '', onTap)
        n.off('mouseover', '', onMouseOver)
        n.off('mouseout', '', onMouseOut)
        n.off('mousemove', '', onMouseMove)
      },
    })
  })

  let destroyed = false

  const controller: MapGraphController = {
    setShowLabels(b: boolean) {
      if (destroyed) return
      showLabels = b
      applyDisplayOptions()
    },
    setShowEdges(b: boolean) {
      if (destroyed) return
      showEdges = b
      applyDisplayOptions()
    },
    setElements(els: ElementDefinition[]) {
      if (destroyed) return
      // Replace the element set in place. We preserve the current
      // pan/zoom by reading the viewport before the swap and
      // restoring it after. We also re-apply the current display
      // toggles because the new elements start with their defaults.
      const zoom = cy.zoom()
      const pan = cy.pan()
      try {
        cy.elements().remove()
        cy.add(els as cytoscape.ElementDefinition[])
        cy.zoom(zoom)
        cy.pan(pan)
      } catch {
        // Defensive: a malformed element list shouldn't crash the
        // page. Swallow and let the next setElements() recover.
      }
      // Re-apply the current display options to the new element
      // set, and re-wire hover/tap handlers for the new nodes.
      applyDisplayOptions()
      cy.nodes().forEach((n) => {
        const id = n.id()
        const onTap = () => opts.onClick?.(id)
        const onMouseOver = () => n.addClass('hover')
        const onMouseOut = () => {
          n.removeClass('hover')
          opts.onHover?.(null, new MouseEvent('mouseleave'))
        }
        const onMouseMove = (evt: cytoscape.EventObject) => {
          const original =
            (evt.originalEvent as MouseEvent | undefined) ??
            (evt as unknown as MouseEvent)
          opts.onHover?.(id, original)
        }
        n.on('tap', onTap)
        n.on('mouseover', onMouseOver)
        n.on('mouseout', onMouseOut)
        n.on('mousemove', onMouseMove)
        handlers.push({
          off: () => {
            n.off('tap', '', onTap)
            n.off('mouseover', '', onMouseOver)
            n.off('mouseout', '', onMouseOut)
            n.off('mousemove', '', onMouseMove)
          },
        })
      })
    },
    setTheme(t: 'light' | 'dark') {
      if (destroyed) return
      if (activeTheme === t) return
      activeTheme = t
      // Cytoscape can't read CSS custom properties in canvas, so
      // swapping the .dark class on <html> doesn't recolor the
      // graph. We have to swap the entire stylesheet.
      cy.style(buildStylesheet(t) as unknown as cytoscape.StylesheetCSS[])
      // Re-apply display options because the new stylesheet reset
      // the per-element text-opacity / display values.
      applyDisplayOptions()
    },
    zoomIn() {
      if (destroyed) return
      const z = cy.zoom()
      cy.zoom(Math.min(3, z * 1.25))
    },
    zoomOut() {
      if (destroyed) return
      const z = cy.zoom()
      cy.zoom(Math.max(0.15, z / 1.25))
    },
    fit() {
      if (destroyed) return
      cy.fit(undefined, 48)
    },
    centerOn(nodeId: string) {
      if (destroyed) return
      const el = cy.getElementById(nodeId)
      if (el && el.length) {
        cy.animate({ center: { eles: el }, duration: 220 } as unknown as cytoscape.AnimationOptions)
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const h of handlers) {
        try {
          h.off()
        } catch {
          // ignore
        }
      }
      try {
        cy.destroy()
      } catch {
        // cytoscape occasionally throws if the container was
        // detached from the DOM before destroy() was called. We
        // don't need the graph anymore, so swallow.
      }
    },
  }

  // Apply the initial display options (no-op by default — both
  // toggles start true) so the first frame matches the toggles.
  applyDisplayOptions()

  return controller
}
