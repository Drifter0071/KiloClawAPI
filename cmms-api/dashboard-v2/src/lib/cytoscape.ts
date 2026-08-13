// src/lib/cytoscape.ts
//
// Cytoscape node factories + style helpers for the Map page (spec §5.3).
//
// Visual rules (Phase 7 v4 — "real colors, real layout"):
//
//   - One node per machine-type group, returned by /v1/jobs/stats
//     (group_by=machine_type). The server defaults to 1000 groups; the
//     client never truncates.
//   - Each node gets a STABLE, UNIQUE HSL color derived from a hash of
//     the model label. Same label → same color across renders and
//     sessions; every distinct label gets a perceptually distinct
//     hue. The previous attempt used cytoscape's `mapData(hue, ...)`
//     mapper which linearly interpolates HSL components and collapses
//     the middle of the spectrum to grey/red — making every node look
//     the same pinkish-red. We now bake the CSS color string directly
//     onto each element's `style.background-color` so the raw hue is
//     preserved.
//   - Node size scales with ticket count, clamped 16..160.
//   - Edges connect each node to its top-K most-similar other nodes
//     (Jaccard on tokenized model names). k=2 by default.
//   - Layout uses `cose-bilkent` 4.x with parameters tuned for an
//     organic, non-grid look. nodeRepulsion is large enough that
//     small/single-ticket groups don't pile up against the big
//     hubs; gravity is low so the cluster fills the canvas.
//   - Labels are TRUNCATED. Long machine names like
//     "DPB-3-40-0-...-120-120-RR-AT" become "DPB-3-40" with the full
//     string available on hover (tooltip + drawer). This is what
//     was destroying the right-side cluster in v3 — every node had
//     its 30+ character label drawn under it, which cytoscape's
//     text renderer happily stacks on top of neighbours.
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
// Edges — top-2 neighbours by token Jaccard similarity
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
 * Build an edge list: each node connects to its top-K most-similar
 * other nodes (Jaccard on tokenized model names). K=2 by default —
 * a low value that keeps the graph readable even at 100+ nodes,
 * while still producing a single connected cluster.
 *
 * Special cases:
 *   - 0 or 1 node: no edges.
 *   - 2 nodes: one edge between them (regardless of similarity —
 *     better than a disconnected graph).
 *   - identical labels: still get cross-edges so the cluster is
 *     connected; the user can see at a glance that two groups
 *     share a name.
 */
export function computeEdges(
  nodes: MapNode[],
  k: number = 2,
  minSim: number = 0.05,
): CyEdge[] {
  if (nodes.length < 2) return []
  const tokens = nodes.map((n) => tokenize(n.model || n.raw || ''))
  const ids = nodes.map((n) => n.model || n.raw || `node-${Math.random().toString(36).slice(2, 8)}`)

  // For each node, score every OTHER node by Jaccard.
  const out: CyEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const scores: Array<{ j: number; w: number }> = []
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue
      const w = jaccard(tokens[i]!, tokens[j]!)
      if (w >= minSim) scores.push({ j, w })
    }
    // Top-K by weight, deterministic tiebreaker by id.
    scores.sort((a, b) => b.w - a.w || ids[a.j]!.localeCompare(ids[b.j]!))
    for (let n = 0; n < Math.min(k, scores.length); n++) {
      const target = scores[n]!
      out.push({ source: ids[i]!, target: ids[target.j]!, weight: target.w })
    }
  }

  // Deduplicate symmetric pairs (i→j and j→i collapse into one edge).
  const seen = new Set<string>()
  const deduped: CyEdge[] = []
  for (const e of out) {
    const k1 = `${e.source}\u0000${e.target}`
    const k2 = `${e.target}\u0000${e.source}`
    if (seen.has(k1) || seen.has(k2)) continue
    seen.add(k1)
    deduped.push(e)
  }

  // 2-node fallback: ensure at least one edge.
  if (deduped.length === 0 && nodes.length === 2) {
    deduped.push({ source: ids[0]!, target: ids[1]!, weight: 1 })
  }

  return deduped
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
    // Edges — thin, low-opacity bezier curves.
    selector: 'edge',
    style: {
      width: 1,
      'line-color': 'rgba(180, 200, 230, 0.18)',
      'target-arrow-color': 'rgba(180, 200, 230, 0.18)',
      'curve-style': 'bezier',
      'control-point-step-size': 40,
      'line-opacity': 0.6,
    },
  },
  {
    // Stronger edge treatment when either endpoint is selected.
    selector: 'edge:selected',
    style: {
      'line-color': 'rgba(96, 165, 250, 0.75)',
      'target-arrow-color': 'rgba(96, 165, 250, 0.75)',
      width: 2,
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
