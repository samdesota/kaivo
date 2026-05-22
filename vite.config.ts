import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export function resolveViteServerConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.CC_CLIENT_HOST ?? env.VITE_HOST ?? '127.0.0.1'
  const port = parsePort(env.CC_CLIENT_PORT ?? env.VITE_PORT ?? '5180')
  const appUrl = env.CC_APP_URL ?? 'http://localhost:3000'

  return {
    host,
    port,
    strictPort: true,
    // Allow the Tailscale Funnel / tailnet hostname to reach the dev server.
    allowedHosts: ['samuels-macbook-pro.tailf71199.ts.net', 'localhost', '127.0.0.1'],
    watch: {
      ignored: [
        '**/.kaivo/**',
        '**/packages/kaivo-desktop/bundle/**',
        '**/packages/kaivo-desktop/release/**',
      ],
    },
    proxy: {
      '/trpc': { target: appUrl, ws: true },
      '/ws': { target: appUrl, ws: true },
      '/api': appUrl,
      '/internal/desktop-auth': appUrl,
      '/healthz': appUrl,
      // Preview proxies live on the API server, not vite — otherwise unknown
      // `/preview/:id/:port/*` paths fall through to the SPA and look like
      // "Not Found".
      '/preview': { target: appUrl, ws: true },
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'server'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: resolveViteServerConfig(),
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
})

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid Vite port: ${value}`)
  return port
}
