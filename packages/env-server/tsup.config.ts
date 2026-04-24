import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  // better-sqlite3 and node-pty ship native bindings; keep external so the
  // compiled binary picks up the installed node_modules at runtime.
  external: ['better-sqlite3', 'node-pty'],
})
