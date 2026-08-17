// tests/askbar.spec.ts
//
// Phase 5 — AskBar.vue (shared ask input). Covers the ↵ enter-key chip
// (the single sitewide submit affordance), Enter submit, and the
// disabled/busy rules.

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AskBar from '../src/components/AskBar.vue'

describe('AskBar', () => {
  it('renders an input bound to modelValue', async () => {
    const wrapper = mount(AskBar, { props: { modelValue: 'M26057' } })
    const input = wrapper.get('[data-testid="ask-bar-input"]')
    expect(input.attributes('value')).toBe('M26057')
    await input.setValue('vezérlés')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['vezérlés'])
  })

  it('shows the ↵ chip only when the field has text, in every size', async () => {
    const lg = mount(AskBar, { props: { modelValue: '', size: 'lg' } })
    expect(lg.find('[data-testid="ask-bar-kbd"]').exists()).toBe(false)

    // setValue emits the event but doesn't re-render with a new prop by
    // itself — drive the chip check via setProps (the real app uses
    // v-model which round-trips the prop).
    await lg.setProps({ modelValue: 'hello' })
    expect(lg.find('[data-testid="ask-bar-kbd"]').exists()).toBe(true)
    expect(lg.get('[data-testid="ask-bar-kbd"]').text()).toBe('↵')

    // Whitespace-only input does not count as text.
    await lg.setProps({ modelValue: '   ' })
    expect(lg.find('[data-testid="ask-bar-kbd"]').exists()).toBe(false)
  })

  it('submits on Enter with the ↵ chip', async () => {
    const wrapper = mount(AskBar, {
      props: { modelValue: 'hello', size: 'lg' },
    })
    expect(wrapper.find('[data-testid="ask-bar-kbd"]').exists()).toBe(true)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')?.[0]).toEqual(['hello'])
  })

  it('does not submit when empty or disabled', async () => {
    const empty = mount(AskBar, { props: { modelValue: '' } })
    await empty.get('form').trigger('submit')
    expect(empty.emitted('submit')).toBeUndefined()

    const disabled = mount(AskBar, { props: { modelValue: 'x', disabled: true } })
    await disabled.get('form').trigger('submit')
    expect(disabled.emitted('submit')).toBeUndefined()
  })

  it('renders a busy spinner inside the ↵ chip when busy', () => {
    const wrapper = mount(AskBar, {
      props: { modelValue: 'x', busy: true },
    })
    const btn = wrapper.get('[data-testid="ask-bar-kbd"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.find('.animate-spin').exists()).toBe(true)
    expect(btn.text()).not.toContain('↵')
  })

  it('uses a custom inputId when provided (for Cmd+K coexistence)', () => {
    const wrapper = mount(AskBar, { props: { modelValue: '', inputId: 'stream-ask-input' } })
    expect(wrapper.get('input').attributes('id')).toBe('stream-ask-input')
  })
})
