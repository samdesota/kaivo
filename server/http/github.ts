import { resolveSession } from '../auth/service.js'
import { SESSION_COOKIE } from '../auth/cookie.js'
import { githubService } from '../github/service.js'
import { consumeCsrf } from '../trpc/routers/github.js'
import { env } from '../env.js'
import { logger } from '../logger.js'

function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

async function isAuthed(cookieHeader: string | undefined): Promise<boolean> {
  const sid = parseCookieHeader(cookieHeader, SESSION_COOKIE)
  if (!sid) return false
  return (await resolveSession(sid)) !== null
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerGitHubRoutes(server: any): void {
  /**
   * Render an HTML page that auto-submits a POST form to GitHub's App-
   * manifest creation endpoint. The form body contains the manifest JSON; the
   * URL carries our CSRF state. GitHub redirects back to /api/github/callback.
   */
  server.get('/api/github/connect', // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (req: any, reply: any) => {
    if (!(await isAuthed(req.headers.cookie as string | undefined))) {
      reply.code(401).send('unauthorized')
      return
    }
    const q = req.query as Record<string, string | undefined>
    const state = (q.state ?? '').trim()
    const org = (q.org ?? '').trim() || null
    if (!state) {
      reply.code(400).send('missing state')
      return
    }
    const manifest = githubService.buildManifest()
    const target = githubService.manifestTargetUrl(org, state)
    const manifestJson = JSON.stringify(manifest)
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connect GitHub</title></head>
<body>
<p>Redirecting to GitHub to create a new GitHub App…</p>
<form id="f" action="${htmlEscape(target)}" method="post">
  <input type="hidden" name="manifest" value="${htmlEscape(manifestJson)}">
  <button type="submit">Continue</button>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`
    reply.type('text/html; charset=utf-8').send(html)
  })

  /**
   * GitHub redirects here after the operator accepts the manifest. We exchange
   * the `code` for the full app credentials and then send the user to install
   * the newly-created app on their org.
   */
  server.get('/api/github/callback', // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (req: any, reply: any) => {
    if (!(await isAuthed(req.headers.cookie as string | undefined))) {
      reply.code(401).send('unauthorized')
      return
    }
    const q = req.query as Record<string, string | undefined>
    const code = (q.code ?? '').trim()
    const state = (q.state ?? '').trim()
    if (!code || !state) {
      reply.code(400).send('missing code or state')
      return
    }
    const csrf = consumeCsrf(state)
    if (!csrf) {
      reply.code(400).send('invalid or expired state')
      return
    }
    try {
      const { appSlug } = await githubService.completeManifest(code)
      const installUrl = csrf.org
        ? `https://github.com/organizations/${encodeURIComponent(csrf.org)}/settings/apps/${encodeURIComponent(appSlug)}/installations/new`
        : `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`
      reply.redirect(installUrl, 302)
    } catch (err) {
      logger.warn({ err }, 'github manifest exchange failed')
      reply.code(500).type('text/plain').send(
        `Failed to complete GitHub App setup: ${(err as Error).message}`,
      )
    }
  })

  /**
   * `setup_url` target; GitHub visits this after installation so we learn the
   * installation id.
   */
  server.get('/api/github/setup', // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (req: any, reply: any) => {
    if (!(await isAuthed(req.headers.cookie as string | undefined))) {
      reply.code(401).send('unauthorized')
      return
    }
    const q = req.query as Record<string, string | undefined>
    const installationId = (q.installation_id ?? '').trim()
    if (!installationId) {
      reply.code(400).send('missing installation_id')
      return
    }
    try {
      await githubService.recordInstallation(installationId)
    } catch (err) {
      logger.warn({ err }, 'recordInstallation failed')
      reply.code(500).type('text/plain').send('failed to record installation')
      return
    }
    // Bounce back into the SPA settings page.
    reply.redirect(`${env.PUBLIC_URL.replace(/\/$/, '')}/settings?github=connected`, 302)
  })
}
