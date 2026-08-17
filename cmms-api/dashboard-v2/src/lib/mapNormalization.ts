// src/lib/mapNormalization.ts
//
// Normalization and data modeling for the NCT Szerviz Ai v2 Spatial Map.
//
// Pure TypeScript — no DOM or Cytoscape dependencies.
// Converts raw API responses into a clean, normalized Map model with
// deduplication, ticket scaling, machine filtering, family grouping, and
// relationship computation.

import type { MapNode as ApiMapNode, MapSample } from './api'

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface NormalizedMapNode {
  id: string
  label: string
  shortLabel: string
  familyKey: string
  familyLabel: string
  tickets: number
  samples: MapSample[]
  hue: number
  color: string
  sizePx: number
  isSingleton: boolean
  relatedIds: string[]
  raw: string
}

export interface MapGroup {
  key: string
  label: string
  hue: number
  color: string
  nodes: NormalizedMapNode[]
  totalTickets: number
  nodeCount: number
}

export interface NormalizedMapEdge {
  id: string
  source: string
  target: string
  weight: number
  sameFamily: boolean
}

export interface MapNormalizationResult {
  nodes: NormalizedMapNode[]
  groups: MapGroup[]
  edges: NormalizedMapEdge[]
  droppedCount: number
  droppedTotalTickets: number
  totalTickets: number
  maxTickets: number
}

// ---------------------------------------------------------------------------
// FNV-1a Hash for Stable Per-Group/Node Color
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

export function nodeHue(label: string): number {
  const key = (label || '').trim().toLowerCase() || 'unknown'
  return fnv1a(key) % 360
}

export function nodeColor(label: string): string {
  const hue = nodeHue(label)
  return `hsl(${hue}, 70%, 62%)`
}

// ---------------------------------------------------------------------------
// Family Key Extractor
// ---------------------------------------------------------------------------

/**
 * Extracts the machine family/type prefix from a raw machine model string.
 */
export function familyKey(model: string): string {
  const raw = (model || '').trim()
  if (!raw) return 'Egyéb'

  // Rule 1: space -> everything before first space (e.g. "TMV-400 vezérlő" -> "TMV-400")
  const spaceIdx = raw.search(/\s/)
  if (spaceIdx > 0) return raw.slice(0, spaceIdx).trim()

  // Rule 2: dot separator (standalone dot, not ellipsis "...")
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

  // Rule 3: dash-separated
  if (!raw.includes('-')) {
    return raw
  }

  const parts = raw.split('-').filter(Boolean)
  if (parts.length === 0) return raw
  if (parts.length === 1) return parts[0]!

  if (parts.length >= 3) return `${parts[0]}-${parts[1]}-${parts[2]}`
  if (parts.length === 2) return `${parts[0]}-${parts[1]}`
  return parts[0]!
}

// ---------------------------------------------------------------------------
// Short Label Formatter
// ---------------------------------------------------------------------------

export function shortLabel(label: string): string {
  const raw = (label || '').trim()
  if (!raw) return '?'
  const parts = raw.split('-').filter(Boolean)
  let candidate = parts.slice(0, 3).join('-')
  if (candidate.length > 18) candidate = candidate.slice(0, 14) + '…'
  if (candidate.length === 0) candidate = raw.slice(0, 16)
  return candidate
}

// ---------------------------------------------------------------------------
// Machine Label Filter (Drops non-machine placeholders & category words)
// ---------------------------------------------------------------------------

const PLACEHOLDER_LABELS = new Set([
  'nincs megadva', 'nincs', 'ismeretlen', 'n/a', 'n.a.', 'üres', 'ures', 'egyéb', 'egyeb',
  'nincs gép', 'nincs gep', 'nincs géptípus', 'nincs geptipus',
  'nem ismert', 'ismeretlen típus', 'ismeretlen tipus', 'egyéb gép', 'egyeb gep',
  'unknown', 'none', 'no data', 'no machine', 'n/a', 'na', 'tbd', 'todo', '-', '—',
  'other', 'misc', 'miscellaneous', 'unspecified', 'undefined', 'null', 'nil',
  'no type', 'no model', 'no machine type', 'not set', 'not specified',
  '(nincs megadva)', '(nincs)', '(ismeretlen)', '(unknown)', '(none)', '(other)', '(misc)',
])

const STATUS_LABELS = new Set([
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
  if (!/[a-z0-9]/.test(v)) return false

  const tokens = v.split(/[\s\-./]+/).filter(Boolean)
  if (tokens.length > 0 && tokens.every((t) => t.length <= 1)) return false
  return true
}

// ---------------------------------------------------------------------------
// Perceptual Ticket Sizing Scale (Square Root Scaling)
// ---------------------------------------------------------------------------

const MIN_NODE_SIZE_PX = 20
const MAX_NODE_SIZE_PX = 76

export function calculateNodeSize(tickets: number, maxTickets: number): number {
  const t = Math.max(0, Number(tickets) || 0)
  if (t === 0) return MIN_NODE_SIZE_PX
  if (maxTickets <= 1) return MIN_NODE_SIZE_PX + 12

  // Square root normalization so high-ticket outlier nodes don't blow up the viewport
  const ratio = Math.sqrt(t) / Math.sqrt(Math.max(1, maxTickets))
  const size = MIN_NODE_SIZE_PX + (MAX_NODE_SIZE_PX - MIN_NODE_SIZE_PX) * ratio
  return Math.round(Math.min(MAX_NODE_SIZE_PX, Math.max(MIN_NODE_SIZE_PX, size)))
}

// ---------------------------------------------------------------------------
// Main Normalization Entry Point
// ---------------------------------------------------------------------------

export function normalizeMapData(rawNodes: ApiMapNode[]): MapNormalizationResult {
  const keptRaw: ApiMapNode[] = []
  const droppedRaw: ApiMapNode[] = []

  for (const n of rawNodes || []) {
    if (isMachineLabel(n.model || n.raw || '')) {
      keptRaw.push(n)
    } else {
      droppedRaw.push(n)
    }
  }

  const droppedCount = droppedRaw.length
  const droppedTotalTickets = droppedRaw.reduce((acc, n) => acc + Math.max(0, n.tickets || 0), 0)

  // Deduplicate kept nodes by id (model/raw)
  const nodeMap = new Map<string, ApiMapNode>()
  for (const n of keptRaw) {
    const id = (n.model || n.raw || '').trim()
    if (!id) continue
    const existing = nodeMap.get(id)
    if (existing) {
      existing.tickets = (existing.tickets || 0) + (n.tickets || 0)
      if (n.samples && n.samples.length > 0) {
        existing.samples = [...(existing.samples || []), ...n.samples]
      }
    } else {
      nodeMap.set(id, { ...n, tickets: Math.max(0, n.tickets || 0) })
    }
  }

  const dedupedRaw = Array.from(nodeMap.values())
  const totalTickets = dedupedRaw.reduce((acc, n) => acc + n.tickets, 0)
  const maxTickets = dedupedRaw.reduce((max, n) => Math.max(max, n.tickets), 0)

  // First pass: Grouping
  const familyMembersMap = new Map<string, ApiMapNode[]>()
  for (const n of dedupedRaw) {
    const fKey = familyKey(n.model || n.raw || '')
    const list = familyMembersMap.get(fKey) || []
    list.push(n)
    familyMembersMap.set(fKey, list)
  }

  // Build normalized nodes
  const nodes: NormalizedMapNode[] = []
  const familyToNodeIds = new Map<string, string[]>()

  for (const n of dedupedRaw) {
    const id = (n.model || n.raw || '').trim()
    const fKey = familyKey(id)
    const members = familyMembersMap.get(fKey) || []
    const isSingleton = members.length <= 1
    const hue = nodeHue(fKey)
    const sizePx = calculateNodeSize(n.tickets, maxTickets)

    const normalizedNode: NormalizedMapNode = {
      id,
      label: id,
      shortLabel: shortLabel(id),
      familyKey: fKey,
      familyLabel: fKey,
      tickets: n.tickets,
      samples: n.samples || [],
      hue,
      color: `hsl(${hue}, 70%, 62%)`,
      sizePx,
      isSingleton,
      relatedIds: [],
      raw: n.raw || id,
    }

    nodes.push(normalizedNode)

    const list = familyToNodeIds.get(fKey) || []
    list.push(id)
    familyToNodeIds.set(fKey, list)
  }

  // Populate relatedIds (other nodes in the same family)
  for (const node of nodes) {
    const siblings = familyToNodeIds.get(node.familyKey) || []
    node.relatedIds = siblings.filter((sId) => sId !== node.id)
  }

  // Build MapGroups
  const groups: MapGroup[] = []
  for (const [fKey, memberNodes] of familyMembersMap.entries()) {
    const memberIds = new Set(memberNodes.map((m) => (m.model || m.raw || '').trim()))
    const matchingNormalized = nodes.filter((n) => memberIds.has(n.id))
    const groupTotalTickets = matchingNormalized.reduce((sum, n) => sum + n.tickets, 0)
    const hue = nodeHue(fKey)

    groups.push({
      key: fKey,
      label: fKey,
      hue,
      color: `hsl(${hue}, 70%, 62%)`,
      nodes: matchingNormalized.sort((a, b) => b.tickets - a.tickets || a.id.localeCompare(b.id)),
      totalTickets: groupTotalTickets,
      nodeCount: matchingNormalized.length,
    })
  }

  // Sort groups by total tickets descending, then node count descending
  groups.sort((a, b) => b.totalTickets - a.totalTickets || b.nodeCount - a.nodeCount || a.key.localeCompare(b.key))

  // Build edges (same family connections)
  const edges: NormalizedMapEdge[] = []
  const edgeSeen = new Set<string>()

  for (const group of groups) {
    if (group.nodes.length < 2) continue
    // Connect each node in the group to its nearest ticket neighbors or in a ring/star backbone
    const gNodes = group.nodes
    for (let i = 0; i < gNodes.length; i++) {
      for (let j = i + 1; j < gNodes.length; j++) {
        const u = gNodes[i]!
        const v = gNodes[j]!
        const edgeKey = u.id < v.id ? `${u.id}:${v.id}` : `${v.id}:${u.id}`
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey)
          edges.push({
            id: `e-${u.id}-${v.id}`,
            source: u.id,
            target: v.id,
            weight: 1,
            sameFamily: true,
          })
        }
      }
    }
  }

  return {
    nodes,
    groups,
    edges,
    droppedCount,
    droppedTotalTickets,
    totalTickets,
    maxTickets,
  }
}
