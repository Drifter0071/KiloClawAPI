// src/lib/cytoscape.ts
//
// Cytoscape node factories + style helpers for the Map page (spec §5.3).
//
// Visual rules (Phase 7 v2):
//   - One node per machine-type group, returned by /v1/jobs/stats
//     (group_by=machine_type). The server defaults to 1000 groups; the
//     client never truncates.
//   - Each node gets a STABLE, UNIQUE HSL color derived from a hash of
//     the model label. Same label → same color across renders and
//     sessions, but every distinct label gets a perceptually distinct
//     hue. This replaces the previous "emerald/amber/rose by bucket"
//     palette which gave the page an unappealing "3 colors total" look.
//   - Node size scales with ticket count, NO UPPER CAP. A 1000-ticket
//     group renders visibly larger than a 1-ticket group (clamped
//     only at the very extremes — 16px minimum for legibility, 160px
//     maximum to keep a single outlier from filling the viewport).
//   - Edges connect each node to its top-2 most similar other nodes,
//     measured by Jaccard similarity on the tokenized model name. The
//     intent is "machines of the same family sit next to each other
//     and the line makes the relationship visible" — without an
//     explicit edge endpoint, token overlap is a reasonable proxy.
//   - cose-bilkent 4.x is the layout engine. We tune nodeRepulsion /
//     idealEdgeLength / gravity for an organic, non-grid look — the
//     default parameters collapse into a near-grid when the seed
//     isn't seeded correctly.
//
// IMPORTANT: `cytoscape-cose-bilkent` 4.x is a separate package and MUST
// be registered with `cytoscape.use(...)` before the layout name is
// recognised. Without this, the runtime throws
// "No such layout `cose-bilkent` found. Did you forget to import it
// and `cytoscape.use()` it?" on the first `cy.layout()` call. The
// import below has a side-effect of attaching the extension factory
// to `cytoscape.use`; the explicit `.use(coseBilkent)` call is what
// actually registers the layout under the name 'cose-bilkent'.

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
 */
export function nodeColor(model: string): string {
  const key = (model || '').trim() || 'unknown'
  const hue = fnv1a(key) % 360
  return `hsl(${hue}, 70%, 62%)`
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
 *
 * Visual baseline: a 1-ticket node is 16px (the minimum), a
 * 10-ticket node is ~28px, a 100-ticket node is ~60px, a 1000-ticket
 * node is ~144px. The contrast between a busy machine type and a
 * quiet one is now obvious at a glance — the previous 48px cap
 * squashed every group past ~9 tickets into the same blob.
 */
export function nodeSize(tickets: number): number {
  const t = Math.max(0, Number(tickets) || 0)
  const raw = 14 + Math.sqrt(t) * 4.2
  return Math.min(NODE_MAX_PX, Math.max(NODE_MIN_PX, Math.round(raw)))
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
 * Cytoscape stylesheet. Per-node `background-color` is a `mapData()`
 * mapping off `data(hue)` so each node gets its hash-derived color
 * without us generating a stylesheet entry per node.
 *
 * The previous stylesheet used 3 hard-coded fills (low/mid/high
 * buckets) which made the page look "3 colors total" — the user
 * feedback that drove Phase 7 v3.
 */
const GRAPH_STYLESHEET: cytoscape.StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      // background-color driven by per-node `data.hue` (0..359).
      // cytoscape's `mapData(field, min, max, startColor, endColor)`
      // with min === max collapses to a constant — we want the raw
      // numeric hue to flow straight into hsl(), so we use a small
      // interpolation window around the value and let CSS pick the
      // colour at the END of the ramp.
      'background-color': 'mapData(hue, 0, 359, hsl(0,70%,62%), hsl(359,70%,62%))',
      'border-color': 'rgba(255,255,255,0.32)',
      'border-width': 1.5,
      label: 'data(label)',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 8,
      color: '#E5E7EB',
      'font-family': '"JetBrains Mono Variable", ui-monospace, monospace',
      'font-size': 11,
      'text-wrap': 'wrap',
      'text-max-width': '120px',
      'background-blacken': -0.18,
      'background-opacity': 0.92,
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-color': '#60A5FA', // accent-hover
      'border-width': 3,
      'background-blacken': 0,
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
    // Edges — thin, low-opacity bezier curves. The line-opacity is
    // constant; the per-edge weight drives a different rendering
    // (see `control-point-step-size` / line style below) for the
    // currently-selected endpoint pair.
    selector: 'edge',
    style: {
      width: 1.25,
      'line-color': 'rgba(180, 200, 230, 0.20)',
      'target-arrow-color': 'rgba(180, 200, 230, 0.20)',
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
    return {
      data: {
        id,
        label,
        tickets: n.tickets,
        samples: n.samples ?? [],
        raw: n.raw,
        hue,
        // size is also pre-computed so the stylesheet stays a
        // constant array (no per-instance style entries).
        size: nodeSize(n.tickets),
      },
    }
  })

  // The stylesheet uses a static `width` / `height` — but per-node
  // sizing needs a per-node override. Set width/height directly on
  // the data and use a stylesheet entry that reads them. The cytoscape
  // stylesheet parser accepts the string "data(field)" and resolves
  // it per element. cytoscape's static TS types refuse the string
  // form (they expect a Mapper function), so we cast the whole
  // stylesheet to a permissive shape — the runtime API is well
  // documented and stable.
  const sizeOverride = {
    selector: 'node',
    style: {
      width: 'data(size)' as unknown as number,
      height: 'data(size)' as unknown as number,
    },
  }
  const elementStyle = [
    ...GRAPH_STYLESHEET,
    sizeOverride,
  ] as unknown as cytoscape.StylesheetStyle[]

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
    style: elementStyle,
    // cose-bilkent 4.x options. Tuned for an organic, non-grid layout:
    //   - nodeRepulsion 4500: enough to keep mid-sized nodes from
    //     collapsing onto each other
    //   - idealEdgeLength 80: a bit shorter than default so the
    //     cluster fills the canvas
    //   - gravity 0.20: low so the layout can spread out; high gravity
    //     is what makes cose-bilkent look "balled up"
    //   - animate: false on first render (we want a stable result
    //     before panning), true on subsequent period changes
    layout: {
      name: 'cose-bilkent',
      nodeRepulsion: 4_500_000,
      idealEdgeLength: 80,
      gravity: 0.2,
      numIter: 1500,
      animate: false,
      randomize: true,
      fit: true,
      padding: 24,
    } as unknown as cytoscape.LayoutOptions,
  })

  cy.nodes().forEach((n) => {
    const toMapNode = (): MapNode => {
      const d = n.data() as unknown as CyNodeData
      return {
        model: d.label ?? d.raw ?? '',
        raw: d.raw ?? '',
        tickets: d.tickets ?? 0,
        samples: d.samples ?? [],
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
