// tests/atoms.test.ts
//
// Placeholder for Phase 3's atom tests. The actual tests live in
// `atoms-form.test.ts`, `atoms-feedback.test.ts`, and
// `atoms-overlay.test.ts` (one per subagent). This file just confirms
// the test runner + @vue/test-utils is wired correctly.
//
// Atoms (per plan §3.1-3.11):
//   Button, Input, SegmentedControl, Badge,
//   EmptyState, ErrorState, Skeleton, Toast,
//   Modal, Drawer, DiffBlock
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

describe('atom test scaffolding', () => {
  it('mounts a trivial Vue component', () => {
    const Hello = defineComponent({
      setup() {
        return () => h('div', { class: 'text-text-primary' }, 'hello atoms')
      },
    })
    const wrapper = mount(Hello)
    expect(wrapper.text()).toBe('hello atoms')
  })

  it('has a #app-like root, not a fragment', () => {
    const Single = defineComponent({
      setup() {
        return () => h('span', 'one')
      },
    })
    const wrapper = mount(Single)
    expect(wrapper.element.tagName).toBe('SPAN')
  })
})
