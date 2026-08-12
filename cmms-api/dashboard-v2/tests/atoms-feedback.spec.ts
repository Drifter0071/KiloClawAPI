// tests/atoms-feedback.test.ts
//
// Phase 3 — feedback-primitive atom tests.
// Covers EmptyState, ErrorState, Skeleton, and Toast (store + container).
//
// Runs under vitest (see vitest.config.ts). The `@vitejs/plugin-vue`
// plugin compiles `.vue` SFCs at import time, so no per-file SFC
// loader is needed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, markRaw, nextTick } from 'vue'
import EmptyState from '../src/components/EmptyState.vue'
import ErrorState from '../src/components/ErrorState.vue'
import Skeleton from '../src/components/Skeleton.vue'
import Toast from '../src/components/Toast.vue'
import { useToastStore, TOAST_TTL_MS, type ToastVariant } from '../src/stores/toast'

// `useToast` is re-exported from `Toast.vue`; we re-derive the same
// shape from the store for testing. The composable is a 1:1 wrapper
// around the store, so this exercises the same code paths.
function makeToastApi() {
  const store = useToastStore()
  return {
    error: (msg: string) => store.push('error', msg),
    warn: (msg: string) => store.push('warning', msg),
    info: (msg: string) => store.push('info', msg),
    dismiss: (id: number) => store.dismiss(id),
  }
}

describe('feedback atoms', () => {
  describe('EmptyState', () => {
    it('renders the title', () => {
      const wrapper = mount(EmptyState, { props: { title: 'No tickets yet' } })
      expect(wrapper.text()).toContain('No tickets yet')
    })

    it('renders the description when provided', () => {
      const wrapper = mount(EmptyState, {
        props: { title: 'No tickets yet', description: 'Create one to get started.' },
      })
      expect(wrapper.text()).toContain('No tickets yet')
      expect(wrapper.text()).toContain('Create one to get started.')
    })

    it('omits the description block when not provided', () => {
      const wrapper = mount(EmptyState, { props: { title: 'Empty' } })
      expect(wrapper.text().trim()).toBe('Empty')
    })

    it('renders the icon when an icon component is provided', () => {
      const DummyIcon = defineComponent({
        name: 'DummyIcon',
        setup() {
          return () => h('svg', { 'data-testid': 'dummy-icon', viewBox: '0 0 24 24' })
        },
      })
      const wrapper = mount(EmptyState, {
        props: { title: 'With icon', icon: markRaw(DummyIcon) },
      })
      expect(wrapper.find('[data-testid="dummy-icon"]').exists()).toBe(true)
    })

    it('does not render an icon when none is provided', () => {
      const wrapper = mount(EmptyState, { props: { title: 'No icon' } })
      expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true)
      expect(wrapper.find('svg').exists()).toBe(false)
    })

    it('renders slotted actions when provided', () => {
      const wrapper = mount(EmptyState, {
        props: { title: 'Empty' },
        slots: { actions: '<button class="action-btn">Add</button>' },
      })
      expect(wrapper.find('.action-btn').exists()).toBe(true)
      expect(wrapper.text()).toContain('Add')
    })

    it('does not render the actions wrapper without the slot', () => {
      const wrapper = mount(EmptyState, { props: { title: 'Empty' } })
      expect(wrapper.find('button').exists()).toBe(false)
    })
  })

  describe('ErrorState', () => {
    it('warning severity uses the warning token (amber)', () => {
      const wrapper = mount(ErrorState, {
        props: { severity: 'warning', title: 'Be careful' },
      })
      expect(wrapper.html()).toContain('text-warning')
    })

    it('error severity uses the danger token (rose)', () => {
      const wrapper = mount(ErrorState, {
        props: { severity: 'error', title: 'Boom' },
      })
      expect(wrapper.html()).toContain('text-danger')
    })

    it('default severity is error', () => {
      const wrapper = mount(ErrorState, { props: { title: 'Oops' } })
      expect(wrapper.attributes('data-severity')).toBe('error')
      expect(wrapper.html()).toContain('text-danger')
    })

    it('renders the title and description', () => {
      const wrapper = mount(ErrorState, {
        props: { severity: 'error', title: 'Network down', description: 'Try again later.' },
      })
      expect(wrapper.text()).toContain('Network down')
      expect(wrapper.text()).toContain('Try again later.')
    })

    it('renders a Retry button when retry prop is provided', () => {
      const wrapper = mount(ErrorState, {
        props: { severity: 'error', title: 'Failed', retry: () => {} },
      })
      const btn = wrapper.find('[data-testid="error-state-retry"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe('Retry')
    })

    it('clicking the Retry button invokes the retry callback', async () => {
      let calls = 0
      const wrapper = mount(ErrorState, {
        props: { severity: 'error', title: 'Failed', retry: () => { calls++ } },
      })
      await wrapper.find('[data-testid="error-state-retry"]').trigger('click')
      expect(calls).toBe(1)
    })

    it('does not render a Retry button when retry prop is absent', () => {
      const wrapper = mount(ErrorState, { props: { severity: 'error', title: 'No retry here' } })
      expect(wrapper.find('[data-testid="error-state-retry"]').exists()).toBe(false)
    })

    it('uses a custom icon component when provided', () => {
      const CustomIcon = defineComponent({
        name: 'CustomIcon',
        setup() {
          return () => h('svg', { 'data-testid': 'custom-error-icon', viewBox: '0 0 24 24' })
        },
      })
      const wrapper = mount(ErrorState, {
        props: { severity: 'error', title: 'X', icon: markRaw(CustomIcon) },
      })
      expect(wrapper.find('[data-testid="custom-error-icon"]').exists()).toBe(true)
    })
  })

  describe('Skeleton', () => {
    it('renders default h-4 and w-full classes', () => {
      const wrapper = mount(Skeleton)
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('h-4')
      expect(cls).toContain('w-full')
      expect(cls).toContain('rounded-md')
      expect(cls).toContain('bg-surface-2')
      expect(cls).toContain('animate-shimmer')
    })

    it('applies the h override', () => {
      const wrapper = mount(Skeleton, { props: { h: 'h-6' } })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('h-6')
      expect(cls).toContain('w-full')
      expect(cls.split(/\s+/)).not.toContain('h-4')
    })

    it('applies the w override', () => {
      const wrapper = mount(Skeleton, { props: { w: 'w-32' } })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('w-32')
      expect(cls.split(/\s+/)).not.toContain('w-full')
    })

    it('applies both h and w overrides', () => {
      const wrapper = mount(Skeleton, { props: { h: 'h-2', w: 'w-1/2' } })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('h-2')
      expect(cls).toContain('w-1/2')
    })

    it('is hidden from assistive tech (aria-hidden=true)', () => {
      const wrapper = mount(Skeleton)
      expect(wrapper.attributes('aria-hidden')).toBe('true')
    })
  })

  describe('Toast', () => {
    let pinia: ReturnType<typeof createPinia>

    beforeEach(() => {
      pinia = createPinia()
      setActivePinia(pinia)
    })

    afterEach(() => {
      setActivePinia(undefined as unknown as ReturnType<typeof createPinia>)
    })

    it('useToast().error() pushes an item to the store', () => {
      const t = makeToastApi()
      t.error('something broke')
      const store = useToastStore()
      expect(store.items.length).toBe(1)
      expect(store.items[0]!.variant).toBe('error')
      expect(store.items[0]!.message).toBe('something broke')
      expect(typeof store.items[0]!.id).toBe('number')
      expect(typeof store.items[0]!.createdAt).toBe('number')
    })

    it('useToast().warn() pushes a warning item', () => {
      const t = makeToastApi()
      t.warn('be careful')
      const store = useToastStore()
      expect(store.items.length).toBe(1)
      expect(store.items[0]!.variant).toBe('warning')
    })

    it('useToast().info() pushes an info item', () => {
      const t = makeToastApi()
      t.info('fyi')
      const store = useToastStore()
      expect(store.items.length).toBe(1)
      expect(store.items[0]!.variant).toBe('info')
    })

    it('useToast().dismiss(id) removes the matching item', () => {
      const t = makeToastApi()
      t.info('first')
      t.info('second')
      const store = useToastStore()
      const firstId = store.items[0]!.id
      t.dismiss(firstId)
      expect(store.items.length).toBe(1)
      expect(store.items[0]!.message).toBe('second')
    })

    it('Toast.vue container renders the current store items', async () => {
      const t = makeToastApi()
      t.error('boom')
      t.warn('heads up')
      t.info('fyi')

      const wrapper = mount(Toast, { attachTo: document.body })
      await nextTick()
      expect(wrapper.find('[data-testid="toast-container"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="toast-error"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="toast-warning"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="toast-info"]').exists()).toBe(true)
      const html = wrapper.html()
      expect(html).toContain('boom')
      expect(html).toContain('heads up')
      expect(html).toContain('fyi')
      wrapper.unmount()
    })

    it('container is empty when the store has no items', async () => {
      const wrapper = mount(Toast, { attachTo: document.body })
      await nextTick()
      expect(wrapper.find('[data-testid="toast-container"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="toast-error"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="toast-warning"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="toast-info"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('clicking the dismiss button removes the item from the store', async () => {
      const t = makeToastApi()
      t.error('will dismiss')
      const store = useToastStore()
      const id = store.items[0]!.id

      const wrapper = mount(Toast, { attachTo: document.body })
      await nextTick()
      const dismiss = wrapper.find(`[data-testid="toast-dismiss-${id}"]`)
      expect(dismiss.exists()).toBe(true)
      await dismiss.trigger('click')
      await nextTick()
      expect(store.items.length).toBe(0)
      wrapper.unmount()
    })

    it('store exports a 5s TTL constant', () => {
      expect(TOAST_TTL_MS).toBe(5000)
    })

    it('auto-dismiss eventually fires (sanity check, not 5s wait)', async () => {
      const realSetTimeout = globalThis.setTimeout
      // @ts-expect-error — intentionally swapping for the test
      globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
        return realSetTimeout(fn, 0)
      }) as typeof setTimeout
      try {
        const t = makeToastApi()
        t.info('auto-dismiss-me')
        const store = useToastStore()
        expect(store.items.length).toBe(1)
        await flushPromises()
        await new Promise<void>((resolve) => realSetTimeout(resolve, 5))
        expect(store.items.length).toBe(0)
      } finally {
        globalThis.setTimeout = realSetTimeout
      }
    })

    // Reference ToastVariant to keep the import live (TS + lint sanity).
    it('ToastVariant is one of the three known strings', () => {
      const v: ToastVariant = 'info'
      expect(['error', 'warning', 'info']).toContain(v)
    })
  })
})
