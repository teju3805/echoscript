import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090A',
          900: '#0C0E10',
          850: '#111417',
          800: '#161A1E',
          700: '#1E242A',
          600: '#2A3239',
          500: '#3A444D',
        },
        bone: {
          100: '#F4F1EC',
          200: '#E4E0D8',
          400: '#A9A79F',
          600: '#6E6E68',
        },
        ember: {
          400: '#FF9E5E',
          500: '#FF7A2F',
          600: '#E85F13',
        },
        mint: {
          400: '#5EEAD4',
          500: '#2DD4BF',
        },
        rose: {
          400: '#FF8A80',
          500: '#F4664F',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Instrument Serif', 'Iowan Old Style', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-800px 0' },
          '100%': { backgroundPosition: '800px 0' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.35', transform: 'scale(0.82)' },
        },
        riseIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        barPulse: {
          '0%, 100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2.4s linear infinite',
        pulseDot: 'pulseDot 1.4s ease-in-out infinite',
        riseIn: 'riseIn 0.35s ease-out both',
        barPulse: 'barPulse 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
