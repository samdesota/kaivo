import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'server'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    // Allow the Tailscale Funnel / tailnet hostname to reach the dev server.
    allowedHosts: ['samuels-macbook-pro.tailf71199.ts.net', 'localhost', '127.0.0.1'],
    proxy: {
      '/trpc': { target: 'http://localhost:3000', ws: true },
      '/ws': { target: 'http://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      // Preview proxies live on the API server, not vite — otherwise unknown
      // `/preview/:id/:port/*` paths fall through to the SPA and look like
      // "Not Found".
      '/preview': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
})
