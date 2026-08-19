import type { Config } from 'tailwindcss'

// ============================================================================
// NCT v2 design tokens
// ----------------------------------------------------------------------------
// The whole UI is built on a 4-layer palette + a single purple accent
// (NCT-500). All component class names resolve through these tokens —
// no hardcoded hex anywhere outside this file (and styles/tokens.css).
//
//   Layer    Token            Used for
//   ──────   ──────────────   ─────────────────────────────────────────
//   chrome   canvas-2         topbar, sidebar, modal panel background
//   content  canvas           chat background, page background
//   surface  surface          elevated cards (drawer, modal, ticket panel)
//   surface  surface-2        row hover, table row backgrounds
//   surface  surface-3        dropdowns, popovers
//   accent   nct-500          primary accent — buttons, links, active state
//   accent   nct-soft         softer accent — text on dark, soft pills
//   text     text-primary     body / heading
//   text     text-secondary   secondary labels
//   text     text-muted       meta, helper, timestamp
//   border   border-subtle    row dividers, default panel edges
//   border   border-default   interactive borders (inputs, dropdowns)
//   border   border-strong    focus / hover edges
//   shell    shell-rail       conversation-rail background
//   shell    shell-rail-text  conversation-rail text
//   shell    shell-rail-border  conversation-rail separator
//   shell    shell-composer   composer background (translucent)
//   shell    shell-divider    thin divider inside the shell
//
// Typography: Inter Variable for UI, JetBrains Mono Variable for
// sorszam / tokens / timestamps. Tabular numerals applied at the
// table layer (not globally) to keep headings proportional.
// ============================================================================

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Structural chrome (topbar, sidebar, modals).
        'canvas-2': 'var(--color-canvas-2)',
        // Content canvas (chat bg, page bg).
        canvas: 'var(--color-canvas)',
        // Elevated surfaces (cards, drawer, modal panel).
        surface: {
          DEFAULT: 'var(--color-surface)',
          2: 'var(--color-surface-2)',
          3: 'var(--color-surface-3)',
        },
        // Semantic borders.
        'border-subtle': 'var(--color-border-subtle)',
        'border-default': 'var(--color-border-default)',
        'border-strong': 'var(--color-border-strong)',
        // Type ramp.
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-muted': 'var(--color-text-muted)',
        'text-inverse': 'var(--color-text-inverse)',
        // Single purple NCT accent. The shade chosen for "500" sits
        // between iOS-systemIndigo and Apple's "purple" — it reads
        // brand-y on dark backgrounds but doesn't fight content.
        nct: {
          50: '#F4F1FE',
          100: '#E5DDFD',
          200: '#C9BCFB',
          300: '#A899F6',
          400: '#8B7AEE',
          500: '#7C5CE5', // primary
          600: '#6845D3',
          700: '#5534B5',
          800: '#41268A',
          900: '#2A175E',
        },
        'nct-soft': 'var(--color-nct-soft)',
        // Chat read region (assistant messages background).
        'chat-read': 'var(--color-chat-read)',
        'chat-read-text': 'var(--color-chat-read-text)',
        // Status colors. iOS-aligned: green, amber, red.
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
        // Shell palette.
        'shell-rail': 'var(--color-shell-rail)',
        'shell-rail-text': 'var(--color-shell-rail-text)',
        'shell-rail-border': 'var(--color-shell-rail-border)',
        'shell-rail-elevated': 'var(--color-shell-rail-elevated)',
        'shell-rail-hover': 'var(--color-shell-rail-hover)',
        'shell-rail-active': 'var(--color-shell-rail-active)',
        'shell-rail-muted': 'var(--color-shell-rail-muted)',
        'shell-composer': 'var(--color-shell-composer)',
        'shell-divider': 'var(--color-shell-divider)',
        'shell-topbar': 'var(--color-shell-topbar)',
        'shell-topbar-border': 'var(--color-shell-topbar-border)',
      },
      fontFamily: {
        sans: ['"Inter Variable"', '"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Strict type ramp, mapped to HIG dynamic-type sizes.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.9375rem', { lineHeight: '1.4rem' }],
        md: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.6rem' }],
        xl: ['1.375rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.75rem', { lineHeight: '2rem' }],
        '3xl': ['2.25rem', { lineHeight: '2.5rem' }],
      },
      borderRadius: {
        md: '6px',
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
      },
      // iOS-style shadow for elevated surfaces. Tuned for both themes:
      // light mode uses a faint warm-black; dark mode would normally
      // need pure black at 50%+ to "punch" the surface, but at that
      // level the shadow reads as a hard hole — so we keep the same
      // low-alpha values and let surface-tint do the elevation work.
      // The dark theme will still get visible separation because each
      // surface step adds ~5% luminance.
      boxShadow: {
        sm: '0 1px 2px 0 rgba(15, 17, 23, 0.18)',
        md: '0 4px 12px 0 rgba(15, 17, 23, 0.22)',
        lg: '0 12px 32px 0 rgba(15, 17, 23, 0.28)',
        tabbar: '0 -1px 0 rgba(255, 255, 255, 0.04), 0 -6px 20px rgba(15, 17, 23, 0.22)',
        topbar: '0 1px 0 rgba(255, 255, 255, 0.04), 0 2px 8px rgba(15, 17, 23, 0.18)',
        glow: '0 0 0 4px rgba(124, 92, 229, 0.20)',
      },
      transitionDuration: {
        DEFAULT: '180ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0, 0, 0.2, 1)',
      },
      // iOS safe-area helpers for the bottom tab bar on notched phones.
      spacing: {
        'safe-bottom': 'env(safe-area-inset-bottom, 0px)',
        'safe-top': 'env(safe-area-inset-top, 0px)',
        // 13 * 4 = 52px — the HIG top-bar height.
        13: '3.25rem',
        // Common 18 (4.5rem) for the 72px-wide side rails on bigger screens.
        18: '4.5rem',
      },
    },
  },
  plugins: [],
} satisfies Config
