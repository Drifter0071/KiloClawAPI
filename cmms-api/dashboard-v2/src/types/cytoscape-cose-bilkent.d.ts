// src/types/cytoscape-cose-bilkent.d.ts
//
// Local type declaration for `cytoscape-cose-bilkent` 4.x.
//
// The package ships only `cytoscape-cose-bilkent.js` — no TypeScript
// types. We import it as a side-effect (the `.use()` call) and the
// extension is registered under the name 'cose-bilkent' on the
// cytoscape singleton. The cast inside `lib/cytoscape.ts` already
// routes the layout-options object through `as unknown as
// cytoscape.LayoutOptions` so we don't actually need any type info
// from this module at the call site.
//
// What this file gives us:
//   - a default export of `any`, so the `import coseBilkent from
//     'cytoscape-cose-bilkent'` line type-checks.
//   - a named export that the `cytoscape.use(ext: ExtensionFn)` call
//     accepts (cytoscape's own types already declare that signature).

declare module 'cytoscape-cose-bilkent' {
  // The default export is the extension factory: a function that
  // mutates the cytoscape singleton to register the layout under
  // the name 'cose-bilkent'.
  const coseBilkent: (cytoscape: typeof import('cytoscape').default) => void
  export default coseBilkent
}
