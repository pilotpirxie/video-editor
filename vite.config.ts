import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const isTestRun = process.env.VITEST !== undefined

export default defineConfig({
  root: isTestRun ? '.' : 'src/renderer',
  base: './',
  build: {
    outDir: resolve('dist/renderer'),
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: [resolve('test/setup.ts')],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
})
