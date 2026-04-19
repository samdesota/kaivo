import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  // Bundle all deps (zod, client helpers) into a single file the sandbox
  // image can COPY in without needing npm.
  noExternal: [/.*/],
})
