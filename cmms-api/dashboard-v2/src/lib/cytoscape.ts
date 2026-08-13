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
 * The stylesheet below is now mostly defaults + per-state visuals.
 */
const GRAPH_STYLESHEET: cytoscape.StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      'border-color': 'rgba(255,255,255,0.32)',
      'border-width': 1.5,
      // `label` is set per-element from `data(shortLabel)`.
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      color: '#E5E7EB',
      'font-family': '"JetBrains Mono Variable", ui-monospace, monospace',
      'font-size': 10,
      'text-wrap': 'wrap',
      'text-max-width': '90px',
      'text-background-color': '#050608',
      'text-background-opacity': 0.6,
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
    // Edges — visible thin curves on the dark canvas. The previous
    // v3 style used rgba(180,200,230,0.18) + width 1 which rendered
    // almost invisible against #050608. Bumped to 0.45 opacity /
    // width 1.5 so the user can actually see "this node is
    // connected to that node" at a glance.
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': 'rgba(180, 200, 230, 0.45)',
      'target-arrow-color': 'rgba(180, 200, 230, 0.45)',
      'curve-style': 'bezier',
      'control-point-step-size': 40,
      'line-opacity': 0.85,
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

  const nodeEntries = nodes.map((n, i) => {
    const id = idOf(n, i)
    const label = n.model || n.raw || `node-${i}`
    const hue = fnv1a(label) % 360
    const size = nodeSize(n.tickets)
    const family = familyKey(label)
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
    elements: [...nodeEntries, ...edgeEntries],
    style: GRAPH_STYLESHEET,
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
