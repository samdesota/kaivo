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
  // tsup's default is to externalize everything declared in `dependencies`,
  // which is what we want here: bundling CJS deps that use dynamic requires
  // (better-sqlite3, pino, …) into ESM produces "Dynamic require of X is
  // not supported" failures at runtime. Ship the bundle alongside a full
  // `npm install` of the env-server package.json instead.
})
