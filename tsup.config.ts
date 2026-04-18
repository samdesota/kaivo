import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['server/index.ts'],
  outDir: 'dist/server',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  skipNodeModulesBundle: true,
  tsconfig: 'tsconfig.server.json',
})
