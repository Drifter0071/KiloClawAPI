// tests/atoms-overlay.test.ts
//
// Phase 3 — overlay + content atom tests.
// Covers Modal, Drawer, and DiffBlock (spec §3.9-3.11).
//
// Runs under vitest (see vitest.config.ts). The `@vitejs/plugin-vue`
// plugin compiles `.vue` SFCs at import time, so no per-file SFC
// loader is needed.
//
// Teleport note: Modal and Drawer use <Teleport to="body">. happy-dom
// provides `document.body`, and Vue's Teleport correctly appends the
// children there. But @vue/test-utils' `wrapper.find()` only walks the
// wrapper's own DOM tree, not the teleported siblings, so we query
// `document.querySelector` directly for the data-testid hooks.

import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import Modal from '../src/components/Modal.vue'
import Drawer from '../src/components/Drawer.vue'
import DiffBlock from '../src/components/DiffBlock.vue'

// Test helpers — query by data-testid on the global document (the
// teleported children live on document.body after <Teleport to="body">).
function $testid(id: string): Element | null {
  return document.querySelector(`[data-testid="${id}"]`)
}

// The Modal/Drawer use <Teleport to="body"> and their backdrop + panel
// are appended to document.body. happy-dom's Teleport handling is good
// but if a test leaves a wrapper mounted (e.g. after an unhandled
// rejection), the next test's $testid() query would find STALE DOM
// from the previous test. Wipe the body between tests so $testid
// always refers to the current mount.
afterEach(() => {
  document.body.innerHTML = ''
})

describe('overlay + content atoms', () => {
  describe('Modal', () => {
    it('renders nothing when open=false', async () => {
      const wrapper = mount(Modal, { props: { open: false } })
      await nextTick()
      expect($testid('modal-backdrop')).toBeNull()
      expect($testid('modal-panel')).toBeNull()
      wrapper.unmount()
    })

    it('renders the panel when open=true', async () => {
      const wrapper = mount(Modal, {
        props: { open: true, title: 'Hello' },
        attachTo: document.body,
      })
      await nextTick()
      const panel = $testid('modal-panel') as HTMLElement
      expect(panel).toBeTruthy()
      expect(panel.getAttribute('role')).toBe('dialog')
      expect(panel.getAttribute('aria-modal')).toBe('true')
      expect(panel.getAttribute('aria-label')).toBe('Hello')
      expect(panel.textContent).toContain('Hello')
      wrapper.unmount()
    })

    it('fires update:open(false) on backdrop click', async () => {
      const wrapper = mount(Modal, { props: { open: true }, attachTo: document.body })
      await nextTick()
      const backdrop = $testid('modal-backdrop') as HTMLElement
      expect(backdrop).toBeTruthy()
      backdrop.dispatchEvent(new Event('click', { bubbles: true }))
      const emitted = wrapper.emitted('update:open')
      expect(emitted).toBeTruthy()
      expect(emitted!.length).toBe(1)
      expect(emitted![0]).toEqual([false])
      wrapper.unmount()
    })

    it('fires update:open(false) on Esc', async () => {
      const wrapper = mount(Modal, { props: { open: true }, attachTo: document.body })
      await nextTick()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      const emitted = wrapper.emitted('update:open')
      expect(emitted).toBeTruthy()
      expect(emitted!.length).toBe(1)
      expect(emitted![0]).toEqual([false])
      wrapper.unmount()
    })

    it('renders default slot content', async () => {
      const wrapper = mount(Modal, {
        props: { open: true },
        slots: { default: '<p class="slot-body">custom body</p>' },
        attachTo: document.body,
      })
      await nextTick()
      const panel = $testid('modal-panel') as HTMLElement
      expect(panel.querySelector('.slot-body')).toBeTruthy()
      expect(panel.textContent).toContain('custom body')
      wrapper.unmount()
    })
  })

  describe('Drawer', () => {
    it('renders nothing when open=false', async () => {
      const wrapper = mount(Drawer, { props: { open: false } })
      await nextTick()
      expect($testid('drawer-backdrop')).toBeNull()
      expect($testid('drawer-panel')).toBeNull()
      wrapper.unmount()
    })

    it('renders the panel when open=true', async () => {
      const wrapper = mount(Drawer, {
        props: { open: true, title: 'Side panel' },
        slots: { default: 'drawer body' },
        attachTo: document.body,
      })
      await nextTick()
      const panel = $testid('drawer-panel') as HTMLElement
      expect(panel).toBeTruthy()
      expect(panel.getAttribute('role')).toBe('dialog')
      expect(panel.getAttribute('aria-modal')).toBe('true')
      expect(panel.getAttribute('aria-label')).toBe('Side panel')
      expect(panel.textContent).toContain('Side panel')
      expect(panel.textContent).toContain('drawer body')
      // Desktop size: 24rem. Mobile (bottom sheet) uses different
      // sizing — checked in the mobile-bottom-sheet test below.
      expect(panel.className.split(/\s+/)).toContain('md:w-96')
      wrapper.unmount()
    })

    it('fires update:open(false) on backdrop click', async () => {
      const wrapper = mount(Drawer, { props: { open: true }, attachTo: document.body })
      await nextTick()
      const backdrop = $testid('drawer-backdrop') as HTMLElement
      expect(backdrop).toBeTruthy()
      backdrop.dispatchEvent(new Event('click', { bubbles: true }))
      const emitted = wrapper.emitted('update:open')
      expect(emitted).toBeTruthy()
      expect(emitted!.length).toBe(1)
      expect(emitted![0]).toEqual([false])
      wrapper.unmount()
    })

    it('fires update:open(false) on Esc', async () => {
      const wrapper = mount(Drawer, { props: { open: true }, attachTo: document.body })
      await nextTick()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      const emitted = wrapper.emitted('update:open')
      expect(emitted).toBeTruthy()
      expect(emitted!.length).toBe(1)
      expect(emitted![0]).toEqual([false])
      wrapper.unmount()
    })

    it('renders a visible close button in the header (works on mobile)', async () => {
      const wrapper = mount(Drawer, {
        props: { open: true, title: 'Géptípus' },
        attachTo: document.body,
      })
      await nextTick()
      const close = $testid('drawer-close') as HTMLElement
      expect(close).toBeTruthy()
      expect(close.getAttribute('aria-label')).toBe('Bezárás')
      close.dispatchEvent(new Event('click', { bubbles: true }))
      const emitted = wrapper.emitted('update:open')
      expect(emitted).toBeTruthy()
      expect(emitted![emitted!.length - 1]).toEqual([false])
      wrapper.unmount()
    })

    it('renders a standalone close button even when no title/header slot is provided', async () => {
      const wrapper = mount(Drawer, { props: { open: true }, attachTo: document.body })
      await nextTick()
      const close = $testid('drawer-close') as HTMLElement
      expect(close).toBeTruthy()
      wrapper.unmount()
    })

    it('renders default slot content', async () => {
      const wrapper = mount(Drawer, {
        props: { open: true },
        slots: { default: '<p class="drawer-slot">drawer slot body</p>' },
        attachTo: document.body,
      })
      await nextTick()
      const panel = $testid('drawer-panel') as HTMLElement
      expect(panel.querySelector('.drawer-slot')).toBeTruthy()
      expect(panel.textContent).toContain('drawer slot body')
      wrapper.unmount()
    })
  })

  describe('DiffBlock', () => {
    it('renders the after text in a <pre>', () => {
      const wrapper = mount(DiffBlock, {
        props: { after: 'line one\nline two' },
      })
      const pre = wrapper.find('pre[data-testid="diff-block-pre"]')
      expect(pre.exists()).toBe(true)
      expect(pre.text()).toBe('line one\nline two')
    })

    it('uses whitespace-pre-wrap on the <pre>', () => {
      const wrapper = mount(DiffBlock, {
        props: { after: 'x' },
      })
      const pre = wrapper.find('pre')
      expect(pre.classes()).toContain('whitespace-pre-wrap')
    })

    it('shows the "előtte → utána" header when before is provided', () => {
      const wrapper = mount(DiffBlock, {
        props: { before: 'old', after: 'new' },
      })
      const header = wrapper.find('[data-testid="diff-block-header"]')
      expect(header.exists()).toBe(true)
      expect(header.text()).toBe('előtte → utána')
    })

    it('hides the header when before is omitted', () => {
      const wrapper = mount(DiffBlock, {
        props: { after: 'just after' },
      })
      expect(wrapper.find('[data-testid="diff-block-header"]').exists()).toBe(false)
    })
  })
})
