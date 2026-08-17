// tests/atoms-form.test.ts
//
// Phase 3 — form-primitive atom tests.
// Covers Button, Input, SegmentedControl, Badge.
//
// Runs under vitest (see vitest.config.ts). The `@vitejs/plugin-vue`
// plugin compiles `.vue` SFCs at import time, so no per-file SFC
// loader is needed (unlike the earlier bun:test setup that required
// a custom Module._extensions hook).

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from '../src/components/Button.vue'
import Input from '../src/components/Input.vue'
import SegmentedControl from '../src/components/SegmentedControl.vue'
import Badge from '../src/components/Badge.vue'

describe('form atoms', () => {
  describe('Button', () => {
    it('renders the slot text', () => {
      const wrapper = mount(Button, {
        slots: { default: 'Save changes' },
      })
      expect(wrapper.text()).toBe('Save changes')
    })

    it('applies primary variant classes by default', () => {
      const wrapper = mount(Button, { slots: { default: 'x' } })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('bg-accent')
      expect(cls).toContain('text-text-inverse')
      expect(cls).toContain('hover:bg-accent-hover')
    })

    it('applies secondary variant classes', () => {
      const wrapper = mount(Button, {
        props: { variant: 'secondary' },
        slots: { default: 'x' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('border-border-default')
      expect(cls).toContain('text-text-primary')
      expect(cls).toContain('hover:bg-surface-2')
    })

    it('applies ghost variant classes', () => {
      const wrapper = mount(Button, {
        props: { variant: 'ghost' },
        slots: { default: 'x' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('text-text-secondary')
      expect(cls).toContain('hover:bg-surface-2')
    })

    it('applies sm size classes', () => {
      const wrapper = mount(Button, {
        props: { size: 'sm' },
        slots: { default: 'x' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('h-7')
      expect(cls).toContain('px-2.5')
      expect(cls).toContain('text-xs')
    })

    it('applies md size classes by default', () => {
      const wrapper = mount(Button, { slots: { default: 'x' } })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('h-9')
      expect(cls).toContain('px-3')
      expect(cls).toContain('text-sm')
    })

    it('applies lg size classes', () => {
      const wrapper = mount(Button, {
        props: { size: 'lg' },
        slots: { default: 'x' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('h-10')
      expect(cls).toContain('px-4')
      expect(cls).toContain('text-base')
    })

    it('fires click event when clicked', async () => {
      const wrapper = mount(Button, { slots: { default: 'Go' } })
      await wrapper.trigger('click')
      expect(wrapper.emitted('click')).toBeTruthy()
      expect(wrapper.emitted('click')!.length).toBe(1)
    })

    it('disabled blocks click', async () => {
      const wrapper = mount(Button, {
        props: { disabled: true },
        slots: { default: 'x' },
      })
      await wrapper.trigger('click')
      expect(wrapper.emitted('click')).toBeFalsy()
      expect((wrapper.element as HTMLButtonElement).disabled).toBe(true)
    })

    it('loading shows spinner and ignores click', async () => {
      const wrapper = mount(Button, {
        props: { loading: true },
        slots: { default: 'Submit' },
      })
      expect(wrapper.find('.animate-spin').exists()).toBe(true)
      expect(wrapper.text().includes('Submit')).toBe(false)
      await wrapper.trigger('click')
      expect(wrapper.emitted('click')).toBeFalsy()
    })
  })

  describe('Input', () => {
    it('typing fires update:modelValue with the new value', async () => {
      const wrapper = mount(Input, { props: { modelValue: '' } })
      const input = wrapper.find('input')
      await input.setValue('hello world')
      const events = wrapper.emitted('update:modelValue')
      expect(events).toBeTruthy()
      expect(events!.at(-1)).toEqual(['hello world'])
    })

    it('monospace adds the font-mono class', () => {
      const wrapper = mount(Input, {
        props: { modelValue: '', monospace: true },
      })
      const cls = wrapper.find('input').classes().join(' ')
      expect(cls).toContain('font-mono')
    })

    it('size="lg" increases the height class', () => {
      const wrapper = mount(Input, {
        props: { modelValue: '', size: 'lg' },
      })
      const cls = wrapper.find('input').classes().join(' ')
      expect(cls).toContain('h-10')
    })

    it('default size applies h-9', () => {
      const wrapper = mount(Input, { props: { modelValue: '' } })
      const cls = wrapper.find('input').classes().join(' ')
      expect(cls).toContain('h-9')
    })

    it('focus ring classes are present on the input', () => {
      const wrapper = mount(Input, { props: { modelValue: '' } })
      const cls = wrapper.find('input').classes().join(' ')
      expect(cls).toContain('focus:ring-2')
      expect(cls).toContain('focus:border-accent')
    })
  })

  describe('SegmentedControl', () => {
    const options = [
      { value: 'day', label: 'Day' },
      { value: 'week', label: 'Week' },
      { value: 'month', label: 'Month' },
    ]

    it('renders all options', () => {
      const wrapper = mount(SegmentedControl, {
        props: { modelValue: 'week', options },
      })
      const buttons = wrapper.findAll('button')
      expect(buttons.length).toBe(3)
      expect(wrapper.text()).toContain('Day')
      expect(wrapper.text()).toContain('Week')
      expect(wrapper.text()).toContain('Month')
    })

    it('click switches the value', async () => {
      const wrapper = mount(SegmentedControl, {
        props: { modelValue: 'day', options },
      })
      const buttons = wrapper.findAll('button')
      await buttons[2]!.trigger('click')
      const events = wrapper.emitted('update:modelValue')
      expect(events).toBeTruthy()
      expect(events!.at(-1)).toEqual(['month'])
    })

    it('the active option has the surface-2 class', () => {
      const wrapper = mount(SegmentedControl, {
        props: { modelValue: 'week', options },
      })
      const buttons = wrapper.findAll('button')
      const active = buttons[1]!
      const inactive = buttons[0]!
      expect(active.classes().join(' ')).toContain('bg-surface-2')
      expect(inactive.classes().join(' ')).not.toContain('bg-surface-2')
    })
  })

  describe('Badge', () => {
    it('renders the label prop', () => {
      const wrapper = mount(Badge, { props: { label: 'open' } })
      expect(wrapper.text()).toBe('open')
    })

    it('renders the default slot when provided', () => {
      const wrapper = mount(Badge, {
        slots: { default: 'critical' },
      })
      expect(wrapper.text()).toBe('critical')
    })

    it('default variant uses surface-2 / text-secondary', () => {
      const wrapper = mount(Badge, {
        props: { label: 'x', variant: 'default' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('bg-surface-2')
      expect(cls).toContain('text-text-secondary')
    })

    it('success variant uses success tokens', () => {
      const wrapper = mount(Badge, {
        props: { label: 'x', variant: 'success' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('bg-success/15')
      expect(cls).toContain('text-success')
    })

    it('warning variant uses warning tokens', () => {
      const wrapper = mount(Badge, {
        props: { label: 'x', variant: 'warning' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('bg-warning/15')
      expect(cls).toContain('text-warning')
    })

    it('danger variant uses danger tokens', () => {
      const wrapper = mount(Badge, {
        props: { label: 'x', variant: 'danger' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('bg-danger/15')
      expect(cls).toContain('text-danger')
    })

    it('info variant uses accent tokens', () => {
      const wrapper = mount(Badge, {
        props: { label: 'x', variant: 'info' },
      })
      const cls = wrapper.classes().join(' ')
      expect(cls).toContain('bg-accent/15')
      expect(cls).toContain('text-accent')
    })

    it('all variants share the base chip classes', () => {
      const variants = ['default', 'success', 'warning', 'danger', 'info'] as const
      for (const v of variants) {
        const wrapper = mount(Badge, { props: { label: 'x', variant: v } })
        const cls = wrapper.classes().join(' ')
        expect(cls).toContain('inline-flex')
        expect(cls).toContain('h-5')
        expect(cls).toContain('rounded-full')
        expect(cls).toContain('px-2')
        expect(cls).toContain('font-mono')
        expect(cls).toContain('uppercase')
      }
    })
  })
})
