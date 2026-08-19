// src/lib/mapLayout.ts
//
// Deterministic spatial layout for the NCT Szerviz Ai v2 Map page.
//
// Goal:
//   - Cluster nodes by family. Within a family, arrange nodes around
//     the family's centroid so the visual "this group belongs together"
//     signal is unambiguous.
//   - Lay out family groups in a 2-D grid so the user can pan/zoom
//     around the canvas without surprise overlaps.
//   - Apply the search query (server-side filter) and produce a final
//     set of `cytoscape.ElementDefinition` objects that cytoscape
//     can render directly. Pre-computed x/y coordinates mean we don't
//     pay a force-directed layout pass at runtime — the only cytoscape
//     layout used is the existing `cose-bilkent` from `lib/cytoscape.ts`
//     for any necessary repulsion. The pre-computed positions are
//     preserved as `position: { x, y }` on every node.
//
// The "elements" output is a flat array (nodes + family-group
// parents + same-family edges). The Map page feeds this directly
// into `createMapGraph`.
//
// All outputs are deterministic for a given input — same nodes +
// same options → same pixel coordinates. This is required so the
// user can reload the page and see the map in the same arrangement.

import type { ElementDefinition } from 'cytoscape'
import { familyKey, nodeColor, nodeSize, shortLabel } from './cytoscape'
import type { MapGroup, NormalizedMapNode, MapNormalizationResult } from './mapNormalization'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GroupingMode = 'family' | 'type'
export type SortMode = 'tickets' | 'name' | 'recent'

export interface MapLayoutOptions {
  groupingMode: GroupingMode
  sortMode: SortMode
  searchQuery: string
  showEdges: boolean
  showLabels: boolean
}

export interface MapLayoutResult {
  /** Flat array of cytoscape element definitions (nodes + groups + edges). */
  elements: ElementDefinition[]
  /** Subset of nodes that survived the search filter (used by list view). */
  visibleNodes: NormalizedMapNode[]
  visibleNodesCount: number
  totalTickets: number
  visibleGroupsCount: number
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Side length of a family "cell" in the grid. Picked so a single-node
 *  family (radius ~14) sits comfortably inside its cell with room for
 *  the label below. */
const FAMILY_CELL = 220

/** Padding around the entire grid. */
const GRID_PADDING = 120

/** Number of columns when laying out family groups in a grid. */
const GRID_COLUMNS = 4

/** Extra padding around the bounding box of the family group frame
 *  (above and to the sides) so the group header label "DPB-3-40"
 *  fits in the top-left corner without overlapping any node. The
 *  cytoscape stylesheet also applies a 24px compound padding, so
 *  the visual gap is `FRAME_PAD + 24px`. */
const FRAME_PAD = 24

/** Extra padding under the bottom of the cluster so the per-node
 *  text labels (which sit below each node) don't bump the lower
 *  border of the group frame. */
const FRAME_PAD_BOTTOM = 48

/** Radius (px) for the ring of nodes inside a family with N members. */
function familyRingRadius(n: number): number {
  // 1 node  → 0 (single dot, no ring)
  // 2..5    → 50
  // 6..12   → 70
  // 13+     → 90
  if (n <= 1) return 0
  if (n <= 5) return 50
  if (n <= 12) return 70
  return 90
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** FNV-1a hash (mirrors the one in lib/cytoscape.ts and mapNormalization.ts)
 *  so the layout can produce deterministic "last-seen" surrogates if no
 *  timestamp is available. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

function lastSeenTimestamp(node: NormalizedMapNode): number {
  // Try the most recent sample's reported_at_iso (any field, pick the
  // largest one we can parse). Falls back to a hash so the sort is
  // still deterministic even if there's no real timestamp.
  let best = 0
  for (const s of node.samples) {
    const t = s && (s as unknown as { reported_at_iso?: string }).reported_at_iso
    if (typeof t === 'string') {
      const parsed = Date.parse(t)
      if (!Number.isNaN(parsed) && parsed > best) best = parsed
    }
  }
  if (best > 0) return best
  // Hash-based deterministic fallback: same node → same surrogate, so
  // re-renders don't shuffle the order.
  return fnv1a(node.id) % 0x7fffffff
}

/** True if the node matches the user's free-text search. */
function matchesQuery(node: NormalizedMapNode, q: string): boolean {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  if (node.id.toLowerCase().includes(needle)) return true
  if (node.label.toLowerCase().includes(needle)) return true
  if (node.familyKey.toLowerCase().includes(needle)) return true
  if (node.familyLabel.toLowerCase().includes(needle)) return true
  for (const s of node.samples) {
    if (s.sorszam && s.sorszam.toLowerCase().includes(needle)) return true
    if (s.snippet && s.snippet.toLowerCase().includes(needle)) return true
    if (s.kategoria && s.kategoria.toLowerCase().includes(needle)) return true
  }
  return false
}

/** Sort a list of nodes by the chosen `sortMode`. Pure function. */
function sortNodes(nodes: NormalizedMapNode[], sortMode: SortMode): NormalizedMapNode[] {
  const arr = nodes.slice()
  if (sortMode === 'tickets') {
    arr.sort((a, b) => b.tickets - a.tickets || a.id.localeCompare(b.id))
  } else if (sortMode === 'name') {
    arr.sort((a, b) => a.id.localeCompare(b.id))
  } else {
    // 'recent' — most recent sample first
    arr.sort((a, b) => lastSeenTimestamp(b) - lastSeenTimestamp(a) || a.id.localeCompare(b.id))
  }
  return arr
}

// ---------------------------------------------------------------------------
// Group / node filter pipeline
// ---------------------------------------------------------------------------

interface ProcessedGroup {
  key: string
  label: string
  hue: number
  color: string
  nodes: NormalizedMapNode[]
  totalTickets: number
  nodeCount: number
}

function processGroups(
  data: MapNormalizationResult,
  searchQuery: string,
): ProcessedGroup[] {
  // 1. Filter nodes by search query.
  const filteredNodes = data.nodes.filter((n) => matchesQuery(n, searchQuery))

  // 2. Rebuild groups from the filtered set so a family whose ALL
  //    members are filtered out drops out of the visible groups.
  const groupsByKey = new Map<string, ProcessedGroup>()
  for (const node of filteredNodes) {
    let g = groupsByKey.get(node.familyKey)
    if (!g) {
      const familyHue = node.hue // hue is already keyed on family in normalization
      g = {
        key: node.familyKey,
        label: node.familyLabel,
        hue: familyHue,
        color: node.color,
        nodes: [],
        totalTickets: 0,
        nodeCount: 0,
      }
      groupsByKey.set(node.familyKey, g)
    }
    g.nodes.push(node)
    g.totalTickets += node.tickets
    g.nodeCount += 1
  }

  // 3. Sort the nodes inside each group by tickets-desc (so the
  //    biggest / most-busy machine is rendered first in the ring).
  for (const g of groupsByKey.values()) {
    g.nodes.sort((a, b) => b.tickets - a.tickets || a.id.localeCompare(b.id))
  }

  return Array.from(groupsByKey.values())
}

// ---------------------------------------------------------------------------
// Coordinate computation
// ---------------------------------------------------------------------------

interface PositionedNode extends NormalizedMapNode {
  position: { x: number; y: number }
}

interface PositionedGroup {
  key: string
  label: string
  hue: number
  color: string
  totalTickets: number
  nodeCount: number
  nodes: PositionedNode[]
  /** Centroid of the group's nodes (for the family-group parent). */
  centroid: { x: number; y: number }
  /** Bounding box of the group's nodes (for sizing the group frame). */
  bbox: { x: number; y: number; w: number; h: number }
}

function positionGroupNodes(
  group: ProcessedGroup,
  originX: number,
  originY: number,
): PositionedGroup {
  const ringR = familyRingRadius(group.nodeCount)
  const positioned: PositionedNode[] = group.nodes.map((n, i) => {
    if (group.nodeCount === 1) {
      return { ...n, position: { x: originX, y: originY } }
    }
    // Place N nodes around a circle. Start at the top (12 o'clock) and
    // walk clockwise so the ring reads as a deliberate cluster, not
    // a random scatter.
    const angle = (i / group.nodeCount) * Math.PI * 2 - Math.PI / 2
    return {
      ...n,
      position: {
        x: originX + Math.cos(angle) * ringR,
        y: originY + Math.sin(angle) * ringR,
      },
    }
  })

  // Compute bounding box. We use the node's full size (diameter)
  // plus an extra `FRAME_PAD` to give the group frame visual
  // breathing room around its children. The bottom gets an extra
  // `FRAME_PAD_BOTTOM` to clear the per-node text labels that sit
  // below each node (cytoscape draws them ~6px below the node
  // plus the font-size of ~10px).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of positioned) {
    const r = p.sizePx / 2
    if (p.position.x - r < minX) minX = p.position.x - r
    if (p.position.y - r < minY) minY = p.position.y - r
    if (p.position.x + r > maxX) maxX = p.position.x + r
    if (p.position.y + r > maxY) maxY = p.position.y + r
  }
  const bbox = {
    x: minX - FRAME_PAD,
    y: minY - FRAME_PAD,
    w: Math.max(80, maxX - minX + 2 * FRAME_PAD),
    h: Math.max(80, maxY - minY + FRAME_PAD + FRAME_PAD_BOTTOM),
  }

  return {
    key: group.key,
    label: group.label,
    hue: group.hue,
    color: group.color,
    totalTickets: group.totalTickets,
    nodeCount: group.nodeCount,
    nodes: positioned,
    centroid: { x: originX, y: originY },
    bbox,
  }
}

function layoutGroupsInGrid(groups: ProcessedGroup[]): PositionedGroup[] {
  // 1. Sort the groups by totalTickets desc so the busiest families
  //    cluster toward the top-left where the user's eye lands first.
  //    Ties: more nodes first (a bigger family reads as "more
  //    important" than a smaller one), then alphabetical.
  const sorted = groups.slice().sort((a, b) => {
    if (b.totalTickets !== a.totalTickets) return b.totalTickets - a.totalTickets
    if (b.nodeCount !== a.nodeCount) return b.nodeCount - a.nodeCount
    return a.key.localeCompare(b.key)
  })

  const positioned: PositionedGroup[] = []
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i]!
    const col = i % GRID_COLUMNS
    const row = Math.floor(i / GRID_COLUMNS)
    const x = GRID_PADDING + col * FAMILY_CELL + FAMILY_CELL / 2
    const y = GRID_PADDING + row * FAMILY_CELL + FAMILY_CELL / 2
    positioned.push(positionGroupNodes(g, x, y))
  }
  return positioned
}

// ---------------------------------------------------------------------------
// Element construction
// ---------------------------------------------------------------------------

function buildGroupParentElement(pg: PositionedGroup): ElementDefinition | null {
  // Only draw a frame for groups with 2+ members (singletons stand on
  // their own and a wrapper would just be visual noise).
  if (pg.nodeCount < 2) return null

  // Stable ID, safe for cytoscape (no spaces / special chars).
  const groupId = `family-${pg.key.replace(/[^A-Za-z0-9_-]/g, '_')}`

  // We DO NOT set explicit position / width / height on the family
  // group: cytoscape auto-sizes a compound parent to wrap its
  // children when the stylesheet declares a `padding` value. That
  // means the bbox math in `positionGroupNodes()` was wasted work —
  // cytoscape will compute the right box itself, and the box will
  // track any node positions automatically (e.g. after setElements
  // when the user zooms / pans / changes the period).
  //
  // We just have to (a) give it a tinted background, (b) dash the
  // border, (c) put the family label in the top-left.
  const fillAlpha = 0.10
  const borderAlpha = 0.55
  return {
    group: 'nodes' as const,
    data: {
      id: groupId,
      label: pg.label,
      family: pg.key,
      hue: pg.hue,
      _isFamilyGroup: true,
      totalTickets: pg.totalTickets,
      nodeCount: pg.nodeCount,
    },
    style: {
      'background-color': `hsla(${pg.hue}, 70%, 62%, ${fillAlpha})`,
      'border-color': `hsla(${pg.hue}, 70%, 62%, ${borderAlpha})`,
    },
  }
}

function buildNodeElement(n: PositionedNode): ElementDefinition {
  const hue = n.hue
  // Children of a family group must reference the parent via
  // `data.parent` so cytoscape recognises them as compound
  // children. The parent ID is the same shape used in
  // buildGroupParentElement.
  const parentId =
    n.relatedIds.length > 0 || !n.isSingleton
      ? `family-${n.familyKey.replace(/[^A-Za-z0-9_-]/g, '_')}`
      : undefined
  const data: Record<string, unknown> = {
    id: n.id,
    label: n.label,
    shortLabel: shortLabel(n.label),
    raw: n.raw,
    tickets: n.tickets,
    samples: n.samples,
    hue,
    family: n.familyKey,
    _familyGroupKey: n.familyKey,
    size: nodeSize(n.tickets),
  }
  if (parentId) data.parent = parentId
  return {
    group: 'nodes' as const,
    data: data as never,
    position: { x: n.position.x, y: n.position.y },
    style: {
      'background-color': nodeColor(n.label),
      'background-opacity': 0.92,
      'background-blacken': -0.18,
      label: shortLabel(n.label),
      width: nodeSize(n.tickets),
      height: nodeSize(n.tickets),
    },
  }
}

function buildEdgeElements(
  nodes: PositionedNode[],
  showEdges: boolean,
  sameFamilyOnly: boolean,
): ElementDefinition[] {
  if (!showEdges) return []
  // Group by family to draw same-family edges only. A family with
  // a single member has no edges.
  const byFamily = new Map<string, PositionedNode[]>()
  for (const n of nodes) {
    const arr = byFamily.get(n.familyKey) ?? []
    arr.push(n)
    byFamily.set(n.familyKey, arr)
  }
  const edges: ElementDefinition[] = []
  const seen = new Set<string>()
  for (const group of byFamily.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const u = group[i]!.id
        const v = group[j]!.id
        const key = u < v ? `${u}\u0000${v}` : `${v}\u0000${u}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          group: 'edges' as const,
          data: {
            id: `e-${key}`,
            source: u,
            target: v,
            weight: 1,
            sameFamily: sameFamilyOnly,
          },
        })
      }
    }
  }
  return edges
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the layout for a normalized map dataset, applying the
 * user's filter + sort + grouping + visibility options.
 *
 * Returns:
 *   - `elements`: flat list of cytoscape ElementDefinition objects
 *     (nodes + family-group parents + edges). Feed this into
 *     `createMapGraph`.
 *   - `visibleNodes`: the filtered, sorted node list (used by the
 *     list view as an alternative rendering).
 *   - `visibleNodesCount`, `totalTickets`, `visibleGroupsCount`:
 *     pre-computed summary numbers for the MapSummary card.
 *
 * Pure: no DOM, no random, no I/O. Deterministic for a given input.
 */
export function generateMapLayout(
  data: MapNormalizationResult,
  options: MapLayoutOptions,
): MapLayoutResult {
  const { groupingMode, sortMode, searchQuery, showEdges } = options
  // `showLabels` and `groupingMode` are exposed in the result so the
  // caller can echo them back; the controller applies them at
  // runtime so the live cytoscape graph reacts to the toggle without
  // rebuilding. `groupingMode` doesn't change the element list today
  // (we always cluster by family) but it's reserved for a future
  // "group by machine type" mode that would change the grid order.
  void groupingMode
  void sortMode

  // 1. Apply search filter + rebuild groups.
  const processedGroups = processGroups(data, searchQuery)

  // 2. Lay out groups in a grid.
  const positionedGroups = layoutGroupsInGrid(processedGroups)

  // 3. Sort the visible nodes by the chosen mode (for the list view).
  const visibleNodes = sortNodes(
    positionedGroups.flatMap((pg) => pg.nodes),
    sortMode,
  )

  // 4. Build the cytoscape elements.
  const elements: ElementDefinition[] = []
  const groupParents: ElementDefinition[] = []

  for (const pg of positionedGroups) {
    // Family-group parent frame (only for 2+ member families).
    const parent = buildGroupParentElement(pg)
    if (parent) groupParents.push(parent)
  }

  // Parents first so the children draw on top (cytoscape respects
  // insertion order for the initial render).
  elements.push(...groupParents)
  for (const pg of positionedGroups) {
    for (const n of pg.nodes) {
      elements.push(buildNodeElement(n))
    }
  }

  // Edges.
  const allNodes = positionedGroups.flatMap((pg) => pg.nodes)
  elements.push(...buildEdgeElements(allNodes, showEdges, true))

  // 5. Summary numbers.
  const visibleNodesCount = allNodes.length
  const totalTickets = allNodes.reduce((acc, n) => acc + n.tickets, 0)
  const visibleGroupsCount = positionedGroups.length

  return {
    elements,
    visibleNodes,
    visibleNodesCount,
    totalTickets,
    visibleGroupsCount,
  }
}

/** Re-export so consumers can grab the helpers from one place. */
export { familyKey, nodeColor, nodeSize, shortLabel }
export type { MapGroup, NormalizedMapNode, MapNormalizationResult } from './mapNormalization'
