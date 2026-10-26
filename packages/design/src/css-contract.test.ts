import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const cssDir = join(here, '..', 'css')
const read = (name: string) => readFileSync(join(cssDir, name), 'utf8')

const tokens = read('tokens.css')
const base = read('base.css')
const deck = read('deck.css')
const tailwindPreset = readFileSync(join(here, '..', 'tailwind-preset.cjs'), 'utf8')
const repoRoot = join(here, '..', '..', '..')
const deviceShell = readFileSync(
  join(repoRoot, 'packages', 'devtools', 'src', 'simulator', 'device-shell', 'device-shell.css'),
  'utf8',
)
const scannedBrowserColorFiles = [
  join(cssDir, 'tokens.css'),
  join(cssDir, 'base.css'),
  join(cssDir, 'deck.css'),
  join(repoRoot, 'docs', 'styles.css'),
  join(repoRoot, 'packages', 'devtools', 'src', 'renderer', 'design.css'),
  join(repoRoot, 'packages', 'devtools', 'src', 'simulator', 'device-shell', 'device-shell.css'),
  join(repoRoot, 'packages', 'devtools', 'src', 'simulator', 'simulator-app.tsx'),
  join(repoRoot, 'packages', 'devtools', 'src', 'simulator', 'simulator-api-media.ts'),
  join(repoRoot, 'packages', 'devtools', 'src', 'preload', 'runtime', 'bridge.ts'),
  join(repoRoot, 'packages', 'devtools', 'src', 'renderer', 'shared', 'lib', 'utils.ts'),
  join(repoRoot, 'packages', 'design', 'README.md'),
] as const
const browserCss = scannedBrowserColorFiles.map(file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
const allowedNonBrowserColorFiles = [
  join(repoRoot, 'docs', 'index.html'),
  join(repoRoot, 'packages', 'devtools', 'src', 'main', 'utils', 'theme.ts'),
  join(repoRoot, 'packages', 'devtools', 'src', 'simulator', 'simulator-api-ui.ts'),
] as const

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!/\.(?:css|tsx?)$/.test(entry.name) || /\.test\./.test(entry.name)) return []
    return [path]
  })
}

const shadcnSurfaceFiles = [
  ...sourceFiles(join(repoRoot, 'packages', 'devtools', 'src', 'renderer')),
  ...sourceFiles(join(repoRoot, 'packages', 'inspect', 'src')),
  join(cssDir, 'base.css'),
  join(cssDir, 'deck.css'),
  join(cssDir, 'index.css'),
]

/** Custom properties a stylesheet DEFINES (`--x: value`). */
function declared(css: string): Set<string> {
  return new Set(css.match(/^\s*(--[\w-]+)\s*:/gm)?.map(m => m.trim().replace(/\s*:$/, '')) ?? [])
}

/** Custom properties a stylesheet READS (`var(--x)`). */
function referenced(css: string): Set<string> {
  return new Set(css.match(/var\(\s*(--[\w-]+)/g)?.map(m => m.replace(/var\(\s*/, '')) ?? [])
}

function values(css: string): Map<string, string> {
  return new Map(
    [...css.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)]
      .map(match => [match[1]!, match[2]!.trim()]),
  )
}

const defined = declared(tokens)

const shadcnTokens = [
  '--background', '--foreground', '--card', '--card-foreground',
  '--popover', '--popover-foreground', '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--border', '--input', '--ring', '--radius',
]

const shadcnPairs = [
  ['--background', '--foreground'],
  ['--card', '--card-foreground'],
  ['--popover', '--popover-foreground'],
  ['--primary', '--primary-foreground'],
  ['--secondary', '--secondary-foreground'],
  ['--muted', '--muted-foreground'],
  ['--accent', '--accent-foreground'],
  ['--destructive', '--destructive-foreground'],
]

describe('shadcn token contract', () => {
  it('defines the standard semantic variables in tokens.css', () => {
    expect([...shadcnTokens].filter(token => !defined.has(token))).toEqual([])
  })

  it('keeps every standard foreground pair complete', () => {
    expect(shadcnPairs.filter(pair => pair.some(token => !defined.has(token)))).toEqual([])
  })

  it('does not retain legacy compatibility variables or selectors', () => {
    const forbidden = [
      ['cor', 'netto'].join(''),
      ['--q', 'd-'].join(''),
      ['.q', 'd-'].join(''),
      ['.cor', 'netto'].join(''),
    ]
    expect(forbidden.filter(value => tokens.toLowerCase().includes(value))).toEqual([])
  })

  it('does not expose pre-shadcn surface aliases', () => {
    const legacyVariable = /^\s*--color-(?:bg(?:-panel)?|surface(?:-[123])?|surface-(?:active|input|selected|thumb|splitter)|border(?:-(?:subtle|strong))?|ring|text(?:-(?:secondary|muted|dim|white))?)\s*:/gm
    const legacyPresetKey = /^\s*(?:bg|'bg-panel'|surface|'surface-[123]'|'surface-(?:active|input|selected|thumb|splitter)'|'border-(?:subtle|strong)'|text|'text-(?:secondary|muted|dim)')\s*:/gm
    expect(tokens.match(legacyVariable) ?? []).toEqual([])
    expect(tailwindPreset.match(legacyPresetKey) ?? []).toEqual([])
  })

  it('uses shadcn semantic surfaces throughout the rendered workspace', () => {
    const legacySurface = /(?:bg|text|border|ring)-(?:bg(?:-panel)?|surface(?:-[123])?|surface-(?:active|input|selected|thumb|splitter)|text(?:-(?:primary|secondary|muted|dim))?|border-(?:subtle|strong))|focus:border-accent|var\(--color-(?:bg|text(?:-[a-z]+)?|surface(?:-[123])?|border(?:-[a-z]+)?|ring)\)/g
    const violations = shadcnSurfaceFiles.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(legacySurface) ?? []
      return matches.map(match => `${file.replace(`${repoRoot}/`, '')}: ${match}`)
    })
    expect(violations).toEqual([])
  })

  it('keeps interactive accent neutral while product accents stay branded', () => {
    // shadcn uses accent for ghost controls, menus and selection states. It
    // must track the neutral surface in both themes rather than primary.
    expect(tokens).toMatch(/--accent:\s*oklch\(0\.269 0 0\)/)
    expect(tokens).toMatch(/--accent-foreground:\s*oklch\(0\.985 0 0\)/)
    expect(tokens).toMatch(/--color-accent:\s*var\(--primary\)/)
    expect(tokens).toMatch(/--color-accent-hover:\s*var\(--primary\)/)
  })

  it('uses shadcn defaults for decorative borders and semantic colors for accessible controls', () => {
    const dark = tokens.slice(0, tokens.indexOf('@media (prefers-color-scheme: light)'))
    const light = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: light)'))
    expect(dark).toMatch(/--primary:\s*oklch\(0\.922 0 0\)/)
    expect(dark).toMatch(/--primary-foreground:\s*oklch\(0\.205 0 0\)/)
    expect(dark).toMatch(/--secondary:\s*oklch\(0\.269 0 0\)/)
    expect(dark).toMatch(/--muted-foreground:\s*oklch\(0\.708 0 0\)/)
    expect(dark).toMatch(/--border:\s*oklch\(1 0 0 \/ 0\.1\)/)
    expect(dark).toMatch(/--input:\s*var\(--muted-foreground\)/)
    expect(dark).toMatch(/--ring:\s*var\(--muted-foreground\)/)
    expect(dark).toMatch(/--scrollbar-thumb:\s*var\(--muted-foreground\)/)
    expect(light).toMatch(/--primary:\s*oklch\(0\.205 0 0\)/)
    expect(light).toMatch(/--primary-foreground:\s*oklch\(0\.985 0 0\)/)
    expect(light).toMatch(/--foreground:\s*oklch\(0\.145 0 0\)/)
    expect(light).toMatch(/--card-foreground:\s*oklch\(0\.145 0 0\)/)
    expect(light).toMatch(/--popover-foreground:\s*oklch\(0\.145 0 0\)/)
    expect(light).toMatch(/--secondary-foreground:\s*oklch\(0\.205 0 0\)/)
    expect(light).toMatch(/--secondary:\s*oklch\(0\.97 0 0\)/)
    expect(light).toMatch(/--accent:\s*oklch\(0\.97 0 0\)/)
    expect(light).toMatch(/--accent-foreground:\s*oklch\(0\.205 0 0\)/)
    expect(light).toMatch(/--muted-foreground:\s*oklch\(0\.556 0 0\)/)
    expect(light).toMatch(/--border:\s*oklch\(0\.922 0 0\)/)
    expect(light).not.toMatch(/--(?:input|ring|scrollbar-thumb):/)
  })

  it('keeps product navigation on dedicated shadcn sidebar semantics', () => {
    expect(tokens).toMatch(/--sidebar:\s*oklch\(0\.205 0 0\)/)
    expect(tokens).toMatch(/--sidebar-primary:\s*oklch\(0\.488 0\.243 264\.376\)/)
  })
})

function oklchToLinear(value: string): [number, number, number, number] {
  const match = value.match(/^oklch\(([^\s]+)\s+([^\s]+)\s+([^\s/)]+)(?:\s*\/\s*([^)]+))?\)$/)
  if (!match) throw new Error(`Expected oklch color, got ${value}`)
  const values = match.slice(1).map(Number)
  const lightness = values[0]!
  const chroma = values[1]!
  const hue = values[2]!
  const a = chroma * Math.cos(hue * Math.PI / 180)
  const b = chroma * Math.sin(hue * Math.PI / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return [
    ...linear.map(channel => Math.max(0, Math.min(1, channel))),
    match[4] === undefined ? 1 : values[3]!,
  ] as [number, number, number, number]
}

function contrast(foreground: string, background: string): number {
  const backgroundChannels = oklchToLinear(background)
  const luminance = (color: string, compositeBackground?: [number, number, number, number]) => {
    let [r, g, b, alpha] = oklchToLinear(color)
    if (alpha < 1 && compositeBackground) {
      r = r * alpha + compositeBackground[0] * (1 - alpha)
      g = g * alpha + compositeBackground[1] * (1 - alpha)
      b = b * alpha + compositeBackground[2] * (1 - alpha)
      alpha = 1
    }
    if (alpha < 1) throw new Error(`Contrast background must be opaque, got ${color}`)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [a, b] = [luminance(foreground, backgroundChannels), luminance(background)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}

function withAlpha(color: string, alpha: number): string {
  return color.replace(/\)$/, ` / ${alpha})`)
}

function contrastOver(foreground: string, background: string, base: string): number {
  const composite = (color: string, behind: [number, number, number, number]) => {
    const [r, g, b, alpha] = oklchToLinear(color)
    return [
      r * alpha + behind[0] * (1 - alpha),
      g * alpha + behind[1] * (1 - alpha),
      b * alpha + behind[2] * (1 - alpha),
      1,
    ] as [number, number, number, number]
  }
  const luminance = ([r, g, b]: [number, number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  const baseChannels = oklchToLinear(base)
  const backgroundChannels = composite(background, baseChannels)
  const foregroundChannels = composite(foreground, backgroundChannels)
  const [a, b] = [luminance(foregroundChannels), luminance(backgroundChannels)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}

describe('browser color contract', () => {
  it('does not use raw palette classes in production renderer or inspect surfaces', () => {
    const productionFiles = [
      ...sourceFiles(join(repoRoot, 'packages', 'devtools', 'src', 'renderer')),
      ...sourceFiles(join(repoRoot, 'packages', 'inspect', 'src')),
    ]
    const rawPalette = /\b(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d+)?(?:\/\d+)?\b/g
    const violations = productionFiles.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(rawPalette) ?? []
      return matches.map(match => `${file.replace(`${repoRoot}/`, '')}: ${match}`)
    })
    expect(violations).toEqual([])
  })

  it('does not use alpha status colors as persistent text or surfaces', () => {
    const productionFiles = [
      ...sourceFiles(join(repoRoot, 'packages', 'devtools', 'src', 'renderer')),
      ...sourceFiles(join(repoRoot, 'packages', 'inspect', 'src')),
    ]
    const statusAlpha = /\b(?:bg|text|border)-(?:status-(?:warn|error|success)|warn-bg|danger-bg)\/\d+\b/g
    const violations = productionFiles.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(statusAlpha) ?? []
      return matches.map(match => `${file.replace(`${repoRoot}/`, '')}: ${match}`)
    })
    expect(violations).toEqual([])
  })

  it('uses oklch for every browser CSS declaration', () => {
    expect(browserCss.join('\n')).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i)
  })

  it('keeps key text and controls above WCAG AA contrast thresholds', () => {
    const lightStart = tokens.indexOf('@media (prefers-color-scheme: light)')
    const darkValues = values(tokens.slice(0, lightStart))
    const lightValues = new Map([...darkValues, ...values(tokens.slice(lightStart))])
    const token = (theme: Map<string, string>, name: string): string => {
      const value = theme.get(name)
      if (!value) throw new Error(`Missing color token ${name}`)
      const alias = value.match(/^var\((--[^)]+)\)$/)?.[1]
      return alias ? token(theme, alias) : value
    }
    const textPairs = [
      [token(darkValues, '--foreground'), token(darkValues, '--background')],
      [token(darkValues, '--card-foreground'), token(darkValues, '--card')],
      [token(darkValues, '--popover-foreground'), token(darkValues, '--popover')],
      [token(darkValues, '--primary-foreground'), token(darkValues, '--primary'), 4.5],
      [token(darkValues, '--secondary-foreground'), token(darkValues, '--secondary')],
      [token(darkValues, '--accent-foreground'), token(darkValues, '--accent')],
      [token(darkValues, '--destructive-foreground'), token(darkValues, '--destructive'), 4.5],
      [token(darkValues, '--destructive'), token(darkValues, '--background'), 4.5],
      [token(darkValues, '--sidebar-foreground'), token(darkValues, '--sidebar')],
      [token(darkValues, '--sidebar-primary-foreground'), token(darkValues, '--sidebar-primary')],
      [token(lightValues, '--foreground'), token(lightValues, '--background')],
      [token(lightValues, '--card-foreground'), token(lightValues, '--card')],
      [token(lightValues, '--popover-foreground'), token(lightValues, '--popover')],
      [token(lightValues, '--primary-foreground'), token(lightValues, '--primary'), 4.5],
      [token(lightValues, '--secondary-foreground'), token(lightValues, '--secondary')],
      [token(lightValues, '--accent-foreground'), token(lightValues, '--accent')],
      [token(lightValues, '--destructive-foreground'), token(lightValues, '--destructive'), 4.5],
      [token(lightValues, '--primary'), token(lightValues, '--background'), 4.5],
      [token(lightValues, '--sidebar-foreground'), token(lightValues, '--sidebar')],
      [token(lightValues, '--sidebar-primary-foreground'), token(lightValues, '--sidebar-primary')],
    ] as const
    for (const [foreground, background, minimum = 4.5] of textPairs) {
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(minimum)
    }

    const productTextTokens = [
      '--color-code-blue',
      '--color-code-orange',
      '--color-code-label',
      '--color-code-number',
      '--color-code-keyword',
      '--success',
      '--warning',
      '--info',
      '--color-status-error',
    ]
    const textSurfaces = ['--background', '--card', '--popover', '--muted']
    for (const theme of [darkValues, lightValues]) {
      for (const surface of ['--background', '--card', '--popover']) {
        expect(
          contrast(token(theme, '--muted-foreground'), token(theme, surface)),
          `--muted-foreground on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      for (const name of productTextTokens) {
        for (const surface of textSurfaces) {
          expect(
            contrast(token(theme, name), token(theme, surface)),
            `${name} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }

      for (const name of ['--input', '--ring', '--scrollbar-thumb']) {
        for (const surface of textSurfaces) {
          expect(
            contrast(token(theme, name), token(theme, surface)),
            `${name} on ${surface}`,
          ).toBeGreaterThanOrEqual(3)
        }
      }

      for (const [foreground, background] of [
        ['--success', '--success-soft'],
        ['--warning', '--warning-soft'],
        ['--info', '--info-soft'],
        ['--color-status-error', '--destructive-soft'],
      ] as const) {
        expect(
          contrast(token(theme, foreground), token(theme, background)),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
      }

      for (const surface of ['--background', '--card'] as const) {
        for (const [foreground, background, opacity] of [
          ['--primary-foreground', '--primary', 0.9],
          ['--secondary-foreground', '--secondary', 0.8],
        ] as const) {
          expect(
            contrastOver(
              token(theme, foreground),
              withAlpha(token(theme, background), opacity),
              token(theme, surface),
            ),
            `${foreground} on ${background}/${opacity * 100} over ${surface}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }

      expect(
        contrastOver(
          token(theme, '--warning'),
          withAlpha(token(theme, '--warning'), 0.15),
          token(theme, '--muted'),
        ),
        '--warning/80 control on --warning/15 over --muted',
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps native and external API color contracts outside the browser CSS scan', () => {
    expect(scannedBrowserColorFiles.filter(file => allowedNonBrowserColorFiles.includes(file as never))).toEqual([])
  })

  it('applies the semantic border token to unqualified component borders', () => {
    const universalRule = base.match(/\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(universalRule).toMatch(/border-color:\s*var\(--border\)/)
  })

  it('does not weaken sidebar text with an opacity modifier', () => {
    const violations = shadcnSurfaceFiles.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(/text-sidebar-foreground\/\d+/g) ?? []
      return matches.map(match => `${file.replace(`${repoRoot}/`, '')}: ${match}`)
    })
    expect(violations).toEqual([])
  })

  it('does not weaken interactive status colors with opacity modifiers', () => {
    const violations = shadcnSurfaceFiles.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(/text-status-(?:warn|error|success)\/\d+/g) ?? []
      return matches.map(match => `${file.replace(`${repoRoot}/`, '')}: ${match}`)
    })
    expect(violations).toEqual([])
  })
})

describe('every variable the stylesheets read is defined', () => {
  // Splitting design.css into three files is exactly the change that can drop
  // a variable on the floor: the rule that uses it and the :root that declares
  // it end up in different files, and a miss paints nothing rather than
  // failing loudly.
  it.each([
    ['tokens.css', tokens],
    ['base.css', base],
    ['deck.css', deck],
  ])('%s', (_name, css) => {
    const missing = [...referenced(css)].filter(v => !defined.has(v))
    expect(missing).toEqual([])
  })
})

describe('dock capacity tab skin contract', () => {
  it('covers the capacity strip and its semantic tabs', () => {
    expect(deck).toMatch(/\[data-deck-group\]\s*>\s*\[role="tablist"\]\s*,\s*\[data-deck-capacity-tabs\]\s*\{[\s\S]*?display:\s*flex/)
    expect(deck).toMatch(/\[data-deck-group\]\s*>\s*\[role="tablist"\]\s*,\s*\[data-deck-capacity-tabs\]\s*\{[\s\S]*?overflow-x:\s*auto/)
    expect(deck).toMatch(/\[data-deck-capacity-tabs\]\s*\[role="tab"\]/)
    expect(deck).toMatch(/\[data-deck-capacity-tabs\]\s*\[role="tab"\]\[aria-selected="true"\]/)
    expect(deck).toMatch(/\[data-deck-capacity-tabs\]\s*\[role="tab"\]:focus-visible/)
  })
})

describe('tailwind-preset.cjs', () => {
  const require_ = createRequire(import.meta.url)
  const preset = require_('../tailwind-preset.cjs') as {
    theme: { extend: Record<string, Record<string, unknown>> }
  }

  function presetVars(): string[] {
    const found = new Set<string>()
    for (const group of Object.values(preset.theme.extend)) {
      for (const value of Object.values(group)) {
        for (const v of referenced(JSON.stringify(value))) found.add(v)
      }
    }
    return [...found]
  }

  it('only aliases variables that tokens.css defines', () => {
    // An alias pointing at an undefined variable compiles fine and produces a
    // class that silently paints nothing.
    const missing = presetVars().filter(v => !defined.has(v))
    expect(missing).toEqual([])
  })

  it('aliases something', () => {
    // Guards the assertion above: an empty extract would make it vacuously pass.
    expect(presetVars().length).toBeGreaterThan(30)
  })
})

describe('light mode overrides', () => {
  const lightBlock = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: light)'))
  const darkBlock = tokens.slice(0, tokens.indexOf('@media (prefers-color-scheme: light)'))

  it('introduces no variable that the dark baseline lacks', () => {
    // Dark is the baseline `:root`; the light block only resets values. A
    // variable that exists only under the light media query is invisible in
    // dark mode, which is the default.
    const darkVars = declared(darkBlock)
    const orphans = [...declared(lightBlock)].filter(v => !darkVars.has(v))
    expect(orphans).toEqual([])
  })

  it('lets a host force dark with the .dark class', () => {
    // In a light system the light block is what wins, so it has to opt out of
    // `.dark` — drop that guard and `.dark` silently becomes a no-op.
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*:where\(:root:not\(\.dark\)\)\s*\{/,
    )
  })

  it('lets a host force light when the system color scheme remains dark', () => {
    expect(tokens).toMatch(/:where\(:root\.light\)\s*\{[\s\S]*?--background:\s*oklch\(1 0 0\)/)
  })

  it('lets explicit theme classes override the simulator desk media query', () => {
    expect(deviceShell).toMatch(/@media \(prefers-color-scheme: light\)[\s\S]*?:root:not\(\.dark\) \.device-shell-root/)
    expect(deviceShell).toMatch(/:root\.light \.device-shell-root/)
  })

  it('keeps package defaults at zero specificity for host themes', () => {
    expect(tokens).toMatch(/^:where\(:root\)\s*\{/m)
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*:where\(:root:not\(\.dark\)\)\s*\{/,
    )
  })
})

describe('separator focus', () => {
  it('keeps a visible keyboard-focus ring', () => {
    // The `:focus` reset removes the outline the browser paints on a pointer
    // drag. Without a `:focus-visible` replacement a keyboard user cannot see
    // which divider they are on.
    const rule = base.match(/\[role="separator"\]:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/outline:\s*(?!none)\S/)
    expect([...referenced(rule)]).toContain('--ring')
  })
})
