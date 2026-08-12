import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        canvas: '#050608',
        'canvas-2': '#0B0D12',
        surface: {
          DEFAULT: '#0F1218',
          '2': '#151A22',
        },
        'border-subtle': 'rgba(255,255,255,0.06)',
        'border-default': 'rgba(255,255,255,0.10)',
        'border-strong': 'rgba(255,255,255,0.16)',
        'text-primary': '#E5E7EB',
        'text-secondary': '#94A3B8',
        'text-muted': '#64748B',
        'text-inverse': '#0B0D12',
        accent: {
          DEFAULT: '#0EA5E9',
          hover: '#38BDF8',
          glow: 'rgba(14,165,233,0.20)',
        },
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#F43F5E',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        md: '6px',
        lg: '10px',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config
