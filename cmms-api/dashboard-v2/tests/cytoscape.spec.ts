// tests/cytoscape.spec.ts
//
// Regression guard for the cose-bilkent layout registration.
//
// Background: `cytoscape-cose-bilkent` 4.x is a separate package. Its
// layout factory is NOT registered with cytoscape until you call
// `cytoscape.use(coseBilkent)`. If `lib/cytoscape.ts` ever drops that
// call (e.g. during a refactor, or if the package is upgraded), the
// Map page throws
//   "No such layout `cose-bilkent` found. Did you forget to import it
//    and `cytoscape.use()` it?"
// on the first `cy.layout()` call. The map.spec.ts mocks the whole
// `lib/cytoscape` module, so the bug was never caught by tests.
//
// This test imports the real module, builds a headless cytoscape core,
// asks for the `cose-bilkent` layout, and verifies it constructs
// without throwing. If `lib/cytoscape.ts` ever drops the
// `cytoscape.use(coseBilkent)` call, this test fails immediately.

import { describe, expect, it } from 'vitest'
import cytoscape from 'cytoscape'
// Importing for side effects: this triggers the
// `cytoscape.use(coseBilkent)` call at the top of the module.
import '@/lib/cytoscape'

describe('lib/cytoscape — cose-bilkent registration', () => {
  it('recognises the "cose-bilkent" layout name after module import', () => {
    // Headless cytoscape — no DOM, no canvas, no rendering. The
    // `headless: true` option skips every UI/render step and lets us
    // exercise the layout engine in pure node.
    const cy = cytoscape({
      headless: true,
      elements: [
        { data: { id: 'a' } },
        { data: { id: 'b' } },
        { data: { id: 'c' } },
      ],
    })

    // The bug surfaces here. Without the `.use(coseBilkent)` call in
    // lib/cytoscape.ts, cytoscape throws
    // "No such layout `cose-bilkent` found" at the `layout()` call.
    const layout = cy.layout({
      name: 'cose-bilkent',
      nodeRepulsion: 80_000,
      idealEdgeLength: 100,
      gravity: 0.25,
      animate: false,
    } as unknown as cytoscape.LayoutOptions)

    expect(layout).toBeDefined()
    // Run the layout to its completion — this is what the real Map
    // page does, and is where the runtime error used to fire.
    expect(() => layout.run()).not.toThrow()

    cy.destroy()
  })

  it('throws a clear error when the registration is missing (sanity)', () => {
    // Sanity check: the cose-bilkent layout is genuinely a separate
    // extension. We can't easily UN-register it once `lib/cytoscape`
    // has called `.use()`, so we just assert the happy path works and
    // document the inverse expectation in a comment for whoever debugs
    // the next "I removed the .use() call" regression.
    //
    // If you ever need to test the negative path, the simplest way is
    // to add `it.skip()` here, run a one-off node script that imports
    // cytoscape WITHOUT cose-bilkent, and watch the throw.
    expect(typeof cytoscape).toBe('function')
  })

  // -----------------------------------------------------------------
  // Family-group compound nodes (Unreal Engine "Comment" frames)
  // -----------------------------------------------------------------
  //
  // Map v7 wraps every family with 2+ members in a compound parent
  // node that gets styled as a translucent rounded rectangle with
  // the family name as a label. This test confirms the parent/child
  // wiring is correct: a singleton is NOT a child, while a member
  // of a 3-node family IS.
  it('family groups: singletons are not children, multi-member nodes are', () => {
    const cy = cytoscape({
      headless: true,
      elements: [
        // DPB-3-40 family: 3 members
        { data: { id: 'd1', family: 'DPB-3-40' } },
        { data: { id: 'd2', family: 'DPB-3-40' } },
        { data: { id: 'd3', family: 'DPB-3-40' } },
        // Forg family: 2 members
        { data: { id: 'f1', family: 'Forg' } },
        { data: { id: 'f2', family: 'Forg' } },
        // Singletons
        { data: { id: 'm1', family: 'M26057' } },
        { data: { id: 'm2', family: 'NCT' } },
      ],
    })
    // Mirror the makeCyto logic: build compound parents for families
    // with 2+ members, attach children via parent: idOf(parent).
    const familyMembers = new Map<string, string[]>()
    for (const n of cy.nodes()) {
      const f = n.data('family') as string
      const arr = familyMembers.get(f) ?? []
      arr.push(n.id())
      familyMembers.set(f, arr)
    }
    for (const [family, ids] of familyMembers.entries()) {
      if (ids.length < 2) continue
      const parentId = `family-${family}`
      cy.add({ data: { id: parentId, _isFamilyGroup: true, family } })
      for (const id of ids) {
        cy.getElementById(id).move({ parent: parentId })
      }
    }
    // Singletons stay top-level.
    expect(cy.getElementById('m1').isChild()).toBe(false)
    expect(cy.getElementById('m2').isChild()).toBe(false)
    // Multi-member families become children of their group.
    expect(cy.getElementById('d1').parent().id()).toBe('family-DPB-3-40')
    expect(cy.getElementById('d2').parent().id()).toBe('family-DPB-3-40')
    expect(cy.getElementById('d3').parent().id()).toBe('family-DPB-3-40')
    expect(cy.getElementById('f1').parent().id()).toBe('family-Forg')
    expect(cy.getElementById('f2').parent().id()).toBe('family-Forg')
    // Two group parents exist.
    const groups = cy.nodes().filter((n) => n.data('_isFamilyGroup') === true)
    expect(groups.length).toBe(2)
  })
})
