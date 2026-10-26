/* Tailwind aliases for the CSS variables in src/css/tokens.css.
 *
 * Every value here must resolve to a variable that tokens.css actually
 * defines — an alias pointing at an undefined variable produces a class that
 * silently paints nothing. tailwind-preset.test.ts derives the variable list
 * from this file and checks it against tokens.css, so the two cannot drift.
 *
 * Usage in a host's tailwind.config.cjs:
 *   presets: [require('@dimina-studio/design/tailwind-preset')]
 * then add your own `content` and any host-owned extensions.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          primary: 'var(--sidebar-primary)',
          'primary-foreground': 'var(--sidebar-primary-foreground)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
          border: 'var(--sidebar-border)',
          ring: 'var(--sidebar-ring)',
        },
        'accent-hover': 'var(--color-accent-hover)',
        'code-blue': 'var(--color-code-blue)',
        'code-orange': 'var(--color-code-orange)',
        'code-label': 'var(--color-code-label)',
        'code-number': 'var(--color-code-number)',
        'code-keyword': 'var(--color-code-keyword)',
        'status-warn': 'var(--color-status-warn)',
        'status-error': 'var(--color-status-error)',
        'status-success': 'var(--color-status-success)',
        'danger-bg': 'var(--color-danger-bg)',
        'warn-bg': 'var(--color-warn-bg)',
        'warn-border': 'var(--color-warn-border)',
        overlay: 'var(--color-overlay)',
        'overlay-heavy': 'var(--color-overlay-heavy)',
      },
      fontFamily: {
        sans: ['var(--font-family)'],
        mono: ['var(--font-family-mono)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
      },
    },
  },
}
