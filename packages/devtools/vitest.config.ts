import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // `e2e/` holds Playwright specs, which vitest must not pick up — hence the
    // `*.test.ts` suffix here versus the `*.spec.ts` those use. It matches the
    // pure helper modules e2e specs share, whose rules decide whether an
    // assertion has anything left to assert.
    include: ['src/**/*.test.{ts,tsx}', 'e2e/**/*.test.ts'],
    globals: true,
    setupFiles: ['./src/renderer/test-setup.ts'],
    server: {
      deps: {
        // electron-deck and view-anchor ship as external npm packages, so vitest
        // would externalize them: their module state then survives
        // `vi.resetModules()` and a suite that re-imports a subject per test
        // gets a deck registry that still believes the previous test's channels
        // are registered. Processing them in the module graph — the same thing
        // the production vite build does when it bundles them — keeps a reset
        // honest.
        inline: ['electron-deck', 'view-anchor'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Uncovered src files count toward the denominator — without an explicit
      // include, vitest only reports files loaded during the run, so a new
      // untested file would not lower the percentage.
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__test-stubs__/**',
        'e2e/**',
        'dist/**',
        'build-*.js',
        // Only the contextBridge entry bundles are unmeasurable glue; the
        // instrumentation/runtime/shared preload logic has unit tests.
        'src/preload/windows/**',
        '**/*.config.*',
        '**/*.d.ts',
        'spike/**',
        'templates/**',
      ],
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: rendererRoot },
      // `service-apis/audio/index.js` imports `../../../common`, a module
      // that only exists inside the dimina submodule at runtime. Map it to a
      // test-only stub so the audio event-bridge unit test can load it.
      {
        find: /^\.\.\/\.\.\/\.\.\/common$/,
        replacement: resolve(
          __dirname,
          'src/simulator/service-apis/audio/__test-stubs__/common.ts',
        ),
      },
      {
        find: '@dimina/common',
        replacement: resolve(
          __dirname,
          'src/simulator/service-apis/__test-stubs__/dimina-common.ts',
        ),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
})
