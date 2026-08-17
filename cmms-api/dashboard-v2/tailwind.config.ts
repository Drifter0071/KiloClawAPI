import type { Config } from 'tailwindcss'

// HIG-flavoured palette (Phase 7 redesign).
//
// Backgrounds: a distinct structural layer (canvas-2, near-black) for
// nav/sidebars, and a content canvas (canvas) for chat / cards. Surfaces
// (`surface`) are the elevated card backgrounds. All values are in
// Apple-system-range: #050608 structural, #0B0D12 chrome, #151A22 cards,
// #1C1C1E table rows.
//
// Accent: a single iOS-blue system accent (#0A84FF-ish) for active
// states + primary actions. Bumped from sky-500 (#0EA5E9) to the
// slightly cooler iOS blue for HIG feel — still legible on near-black.
//
// Typography: Inter Variable for UI text, JetBrains Mono Variable for
// sorszam / timestamps / tokens. Tabular numerals applied at the table
// layer (not globally) to keep headings proportional.
//
// Geometry: rounded-md = 6px, rounded-lg = 10px, rounded-xl = 14px
// (macOS-window corner). The pill radius is reserved for toggles /
// status chips only.

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        // Structural chrome (topbar, sidebar, modals).
        'canvas-2': '#0B0D12',
        // Content canvas (chat bg, page bg).
        canvas: '#050608',
        // Elevated surfaces (cards, drawer, modal panel).
        surface: {
          DEFAULT: '#151A22',
          '2': '#1C1C1E',
          '3': '#23272F',
        },
        // Semantic borders (1px).
        'border-subtle': 'rgba(255,255,255,0.06)',
        'border-default': 'rgba(255,255,255,0.10)',
        'border-strong': 'rgba(255,255,255,0.18)',
        // Type ramp.
        'text-primary': '#F2F2F7',
        'text-secondary': '#A1A1AA',
        'text-muted': '#6B6F76',
        'text-inverse': '#0B0D12',
        // Single system accent (iOS-blue). Hover is a brighter tint.
        accent: {
          DEFAULT: '#3B82F6',
          hover: '#60A5FA',
          glow: 'rgba(59,130,246,0.20)',
        },
        // Status colors. iOS-aligned: green, amber, red.
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#F43F5E',
        // iOS-style tab bar background (mobile bottom nav).
        'tabbar': 'rgba(11,13,18,0.85)',
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
      // iOS-standard shadow for elevated surfaces (drawer / modal / tab bar).
      boxShadow: {
        'sm': '0 1px 2px 0 rgba(0,0,0,0.30)',
        'md': '0 4px 12px 0 rgba(0,0,0,0.40)',
        'lg': '0 12px 32px 0 rgba(0,0,0,0.50)',
        'tabbar': '0 -1px 0 rgba(255,255,255,0.06), 0 -4px 16px rgba(0,0,0,0.40)',
        'topbar': '0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.30)',
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
      },
    },
  },
  plugins: [],
} satisfies Config
