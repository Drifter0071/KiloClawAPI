// src/lib/cytoscape.ts
//
// Cytoscape node factories + style helpers for the Map page (spec §5.3).
//
// Visual rules (Phase 7 v5 — "everything connected, edges visible"):
//
//   - One node per machine-type group, returned by /v1/jobs/stats
//     (group_by=machine_type). The server defaults to 1000 groups; the
//     client never truncates.
//   - Each node gets a STABLE, UNIQUE HSL color derived from a hash of
//     the model label. Same label → same color across renders and
//     sessions; every distinct label gets a perceptually distinct
//     hue. The previous v3 attempt used cytoscape's `mapData(hue, ...)`
//     mapper which linearly interpolates HSL components and collapses
//     the middle of the spectrum to grey/red — making every node look
//     the same pinkish-red. We now bake the CSS color string directly
//     onto each element's `style.background-color` so the raw hue is
//     preserved.
//   - Node size scales with ticket count, clamped 16..160.
//   - Edges are built in two passes: adaptive k-NN by combined
//     similarity (Jaccard + longest-common-prefix bonus) PLUS a
//     "no island" guarantee that connects any isolated node to its
//     nearest neighbour. k is scaled to graph size: 3..8 depending
//     on N. Result: 30+ edges for a 30-node graph (vs ~5 in v3).
//   - Edge style is bumped to width 1.5, opacity 0.45 — visible on
//     the dark canvas without overwhelming the nodes.
//   - Layout uses `cose-bilkent` 4.x with parameters tuned for an
//     organic, non-grid look. nodeRepulsion is large enough that
//     small/single-ticket groups don't pile up against the big
//     hubs; gravity is low so the cluster fills the canvas.
//   - Labels are TRUNCATED. Long machine names like
//     "DPB-3-40-0-...-120-120-RR-AT" become "DPB-3-40" with the full
//     string available on hover (tooltip + drawer).
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

/** FNV-1a 32-bit. Deterministic, fast, no deps. The same string
 *  always produces the same hash; distinct strings produce distinct
 *  hues with high probability even for short model labels. */
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

/**
 * Cheap character-level similarity for nodes that share little
 * token overlap. Counts the length of the longest common prefix
 * (up to 6 chars) and returns it normalised to 0..1.
 *
 * This rescues the "DPB-3-40-..." family: every DPB-3-40 variant
 * gets a +0.4 boost from the "dpb-3" prefix even when Jaccard
 * drops low because of the many variant tokens.
 */
function prefixBonus(a: string, b: string): number {
  if (!a || !b) return 0
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  let i = 0
  const max = Math.min(al.length, bl.length, 6)
  while (i < max && al[i] === bl[i]) i += 1
  return i / 6
}

/** Combined similarity score in 0..1. Weighted sum of:
 *    - 0.65 * Jaccard on tokens (primary signal)
 *    - 0.35 * longest-common-prefix bonus (rescue for family ties)
 *  Both signals max out near 1 for tight family clusters.
 */
function similarity(a: Set<string>, b: Set<string>, labelA: string, labelB: string): number {
  const j = jaccard(a, b)
  const p = prefixBonus(labelA, labelB)
  // Bonus is small (≤ 0.35) so unrelated labels still score 0.
  return Math.min(1, j * 0.65 + p * 0.35)
}

/**
 * Pick a k appropriate for the graph size. The previous v3 used a
 * flat k=2 which left most nodes visibly disconnected (only the
 * top-2 closest neighbours of each node got a line, and symmetric
 * dedup collapsed them to ~5 unique pairs for 30+ nodes).
 *
 *   N nodes → k neighbours
 *   -------   ------------
 *     3..8    3
 *     9..20   4
 *    21..50   5
 *    51..100  6
 *     100+    7
 *
 * This gives every node at least 3 lines by default, which on a
 * 30-node graph produces ~30+ edges after dedup — the canvas reads
 * as "everything is connected to everything" while still letting
 * the family clusters (high-similarity edges) stand out.
 */
function adaptiveK(n: number): number {
  if (n <= 8) return 3
  if (n <= 20) return 4
  if (n <= 50) return 5
  if (n <= 100) return 6
  return 7
}

/**
 * Build an edge list with TWO passes:
 *
 *   Pass 1 — adaptive k-NN by combined similarity (Jaccard + LCP).
 *     Each node connects to its k nearest neighbours. Edges are
 *     symmetric-deduped.
 *
 *   Pass 2 — "no island" guarantee. After Pass 1 some nodes may
 *     still have no edges (e.g. a node whose model name shares no
 *     tokens with anything else). For each isolated node, add ONE
 *     edge to its best-scoring other node (by the same similarity
 *     function, even if the score is low). Result: zero islands.
 *
 * The user explicitly asked for "they should be linked together"
 * — disconnected nodes were the v3 bug. Pass 2 fixes it.
 */
export function computeEdges(
  nodes: MapNode[],
  k?: number,
  minSim: number = 0.02,
): CyEdge[] {
  if (nodes.length < 2) return []
  const tokens = nodes.map((n) => tokenize(n.model || n.raw || ''))
  const labels = nodes.map((n) => n.model || n.raw || '')
  const ids = nodes.map((n, i) => n.model || n.raw || `node-${i}`)

  const effectiveK = k ?? adaptiveK(nodes.length)

  // Pairwise similarity matrix (upper triangle only — symmetric).
  const N = nodes.length
  const sim: number[][] = Array.from({ length: N }, () => new Array(N).fill(0))
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const s = similarity(tokens[i]!, tokens[j]!, labels[i]!, labels[j]!)
      sim[i]![j] = s
      sim[j]![i] = s
    }
  }

  // ---- Pass 1: adaptive k-NN ----
  const candidate: CyEdge[] = []
  for (let i = 0; i < N; i++) {
    const rowI = sim[i]!
    // Sort other indices by sim desc, deterministic id tiebreak.
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

  // ---- Pass 2: no island ----
  // For every node that has zero edges, add ONE to its best-scoring
  // other node. If the best score is 0 (no token/prefix overlap
  // with anything — e.g. an "NCT" node in a graph full of "DPB-..."
  // labels), fall back to the lexicographically nearest neighbour
  // so the node is still connected to SOMETHING. The edge will
  // render at the same faint base opacity as every other line —
  // the user reads it as "this is a lonely machine" and that's
  // exactly the right signal.
  const degree = new Array<number>(N).fill(0)
  for (const e of edges) {
    const a = ids.indexOf(e.source)
    const b = ids.indexOf(e.target)
    if (a >= 0) degree[a]! += 1
    if (b >= 0) degree[b]! += 1
  }
  for (let i = 0; i < N; i++) {
    if (degree[i]! > 0) continue
    // Find best-scoring other node, or fall back to the first
    // non-self node alphabetically if nothing has any similarity.
    let bestJ = -1
    let bestW = 0
    let fallbackJ = -1
    for (let j = 0; j < N; j++) {
      if (i === j) continue
      if (sim[i]![j]! > bestW) {
        bestW = sim[i]![j]!
        bestJ = j
      }
      if (fallbackJ < 0 || ids[j]!.localeCompare(ids[fallbackJ]!) < 0) {
        fallbackJ = j
      }
    }
    const targetJ = bestJ >= 0 ? bestJ : fallbackJ
    if (targetJ < 0) continue
    const e: CyEdge = { source: ids[i]!, target: ids[targetJ]!, weight: bestW }
    const k1 = `${e.source}\u0000${e.target}`
    const k2 = `${e.target}\u0000${e.source}`
    if (seen.has(k1) || seen.has(k2)) continue
    seen.add(k1)
    edges.push(e)
    degree[i]! += 1
    degree[targetJ]! += 1
  }

  // 2-node fallback: ensure at least one edge in the trivial case.
  if (edges.length === 0 && N === 2) {
    edges.push({ source: ids[0]!, target: ids[1]!, weight: 1 })
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
    return {
      data: {
        id,
        label,
        shortLabel: shortLabel(label),
        tickets: n.tickets,
        samples: n.samples ?? [],
        raw: n.raw,
        hue,
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
    const toMapNode = (): MapNode & { _color: string; _hue: number } => {
      const d = n.data() as unknown as CyNodeData
      return {
        model: d.label ?? d.raw ?? '',
        raw: d.raw ?? '',
        tickets: d.tickets ?? 0,
        samples: d.samples ?? [],
        _color: `hsl(${d.hue}, 70%, 62%)`,
        _hue: d.hue,
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
