// src/lib/cytoscape.ts
//
// Cytoscape node factories + style helpers for the Map page (spec §5.3).
//
// v1 ships NODES ONLY — no edges (no endpoint exposes the customer↔
// machine matrix; tracked as spec §9 follow-up #1). The graph layout is
// `cose-bilkent` (the maintained successor to the abandoned
// `cytoscape-cose`).
//
// IMPORTANT: `cytoscape-cose-bilkent` 4.x is a separate package and MUST
// be registered with `cytoscape.use(...)` before the layout name is
// recognised. Without this, the runtime throws
// "No such layout `cose-bilkent` found. Did you forget to import it
// and `cytoscape.use()` it?" on the first `cy.layout()` call. The
// import below has a side-effect of attaching the extension factory
// to `cytoscape.use`; the explicit `.use(coseBilkent)` call is what
// actually registers the layout under the name 'cose-bilkent'.
//
// Node rules (spec §5.3):
//   - 20–48px circles sized by ticket count (sqrt-scaled, capped)
//   - fill: emerald < 3, amber 3–9, rose >= 10
//   - stroke 1px border-strong, hover 2px sky-500
//   - label: machine type below the node, monospace 10px
//
// This module is the ONLY place that imports cytoscape (besides the
// MapPage route), so Vite's manualChunks keeps the whole cytoscape
// dependency in the map chunk, loaded on first navigation.

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
}

export type TicketBucket = 'low' | 'mid' | 'high'

// ---------------------------------------------------------------------------
// Color / size rules
// ---------------------------------------------------------------------------

/** Spec §5.3: emerald < 3, amber 3–9, rose >= 10. */
export function bucketForTickets(tickets: number): TicketBucket {
  if (tickets < 3) return 'low'
  if (tickets <= 9) return 'mid'
  return 'high'
}

/** Node fill color per bucket (matches the design tokens). */
export const NODE_COLORS: Record<TicketBucket, string> = {
  low: '#10B981', // emerald (success)
  mid: '#F59E0B', // amber (warning)
  high: '#F43F5E', // rose (danger)
}

/**
 * Node diameter: 20–48px, sqrt-scaled so huge counts don't explode the
 * canvas (a 65k-ticket group must still be a circle, not a planet).
 */
export function nodeSize(tickets: number): number {
  const raw = 20 + Math.sqrt(Math.max(0, tickets)) * 4
  return Math.min(48, Math.max(20, Math.round(raw)))
}

/** Full node style map consumed by the cytoscape stylesheet. */
export function nodeStyle(tickets: number): cytoscape.Css.Node {
  return {
    width: nodeSize(tickets),
    height: nodeSize(tickets),
    'background-color': NODE_COLORS[bucketForTickets(tickets)],
    'border-color': 'rgba(255,255,255,0.16)', // border-strong
    'border-width': 1,
  }
}

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

const GRAPH_STYLESHEET: cytoscape.StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      color: '#94A3B8', // text-secondary
      'font-family': '"JetBrains Mono Variable", ui-monospace, monospace',
      'font-size': 10,
      'text-wrap': 'wrap',
      'text-max-width': '96px',
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-color': '#0EA5E9', // sky-500
      'border-width': 2,
    },
  },
  {
    selector: 'node:active',
    style: {
      'border-color': '#38BDF8', // sky-400
      'border-width': 2,
    },
  },
]

/**
 * Build a Cytoscape core for the given nodes.
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
  const cy = cytoscape({
    container: el,
    elements: nodes.map((n) => ({
      data: {
        id: n.model || n.raw || `node-${Math.random().toString(36).slice(2, 8)}`,
        label: n.model || n.raw,
        tickets: n.tickets,
        samples: n.samples ?? [],
        raw: n.raw,
      },
    })),
    style: GRAPH_STYLESHEET,
    // cose-bilkent 4.x options. The extension is registered at module
    // load time (see the `cytoscape.use(coseBilkent)` call at the top
    // of this file); the layout name resolves to the extension's
    // factory at runtime. The cast below is because 'cose-bilkent' is
    // not part of cytoscape's core LayoutOptions union.
    layout: {
      name: 'cose-bilkent',
      nodeRepulsion: 80_000,
      idealEdgeLength: 100,
      gravity: 0.25,
      animate: true,
    } as unknown as cytoscape.LayoutOptions,
  })

  cy.nodes().forEach((n) => {
    const toMapNode = () => {
      const d = n.data() as unknown as CyNodeData
      return {
        model: d.label ?? d.raw ?? '',
        raw: d.raw ?? '',
        tickets: d.tickets ?? 0,
        samples: d.samples ?? [],
      }
    }
    n.on('tap', () => onClick?.(toMapNode()))
    n.on('mousemove', (evt) => onHover?.(toMapNode(), evt.originalEvent ?? evt))
  })

  return cy
}
