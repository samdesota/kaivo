import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { githubInstall, githubTokenCache } from '../db/schema.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import { getSecret, putSecret } from '../secrets/index.js'

export class GitHubError extends Error {
  constructor(
    public code:
      | 'not_connected'
      | 'not_installed'
      | 'manifest_exchange_failed'
      | 'token_mint_failed'
      | 'api_error',
    message: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export interface GitHubStatus {
  connected: boolean
  installed: boolean
  orgLogin: string | null
  appSlug: string | null
  connectedAt: Date | null
}

export interface GitHubRepoSummary {
  id: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
  cloneUrl: string
  description: string | null
}

const PRIVATE_KEY_SECRET = 'github_app.private_key'
const WEBHOOK_SECRET_SECRET = 'github_app.webhook_secret'
const CLIENT_SECRET_SECRET = 'github_app.client_secret'

/** Minimal base64url helper. */
function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000)
  // GitHub accepts iat skew up to 60s; back-date slightly to be safe.
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId }
  const header = { alg: 'RS256', typ: 'JWT' }
  const enc =
    b64url(Buffer.from(JSON.stringify(header))) +
    '.' +
    b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.createSign('RSA-SHA256').update(enc).sign(privateKeyPem)
  return enc + '.' + b64url(sig)
}

export class GitHubService {
  private installationTokenCache: { token: string; expiresAt: number } | null = null

  async getRow() {
    const rows = await db.select().from(githubInstall).where(eq(githubInstall.id, 1)).limit(1)
    return rows[0] ?? null
  }

  async status(): Promise<GitHubStatus> {
    const row = await this.getRow()
    if (!row) {
      return { connected: false, installed: false, orgLogin: null, appSlug: null, connectedAt: null }
    }
    return {
      connected: true,
      installed: Boolean(row.installationId),
      orgLogin: row.orgLogin,
      appSlug: row.appSlug,
      connectedAt: row.connectedAt,
    }
  }

  /**
   * Build the URL to render the App-manifest creation form against. Caller
   * serves an auto-submitting form that POSTs `manifest` to this URL. GitHub
   * then redirects back to our callback with `code` + `state`.
   */
  manifestTargetUrl(orgLogin: string | null, csrfState: string): string {
    const base = orgLogin
      ? `https://github.com/organizations/${encodeURIComponent(orgLogin)}/settings/apps/new`
      : 'https://github.com/settings/apps/new'
    return `${base}?state=${encodeURIComponent(csrfState)}`
  }

  buildManifest(): Record<string, unknown> {
    const publicUrl = env.PUBLIC_URL.replace(/\/$/, '')
    return {
      name: 'Cloud Coding Env',
      url: publicUrl,
      hook_attributes: { url: `${publicUrl}/api/github/webhook`, active: false },
      redirect_url: `${publicUrl}/api/github/callback`,
      setup_url: `${publicUrl}/api/github/setup`,
      setup_on_update: true,
      public: false,
      default_permissions: {
        contents: 'write',
        metadata: 'read',
        pull_requests: 'write',
      },
      default_events: [],
    }
  }

  /**
   * Exchange the manifest code for the full app credentials (id, pem,
   * webhook secret, etc.), then store them.
   */
  async completeManifest(code: string): Promise<{ orgLogin: string | null; appSlug: string }> {
    const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cloud-coding-env',
      },
    })
    if (!res.ok) {
      throw new GitHubError(
        'manifest_exchange_failed',
        `github returned ${res.status} exchanging manifest`,
      )
    }
    const body = (await res.json()) as {
      id: number
      slug: string
      owner: { login: string; type: string }
      pem: string
      webhook_secret?: string
      client_id?: string
      client_secret?: string
    }

    await putSecret(PRIVATE_KEY_SECRET, body.pem)
    if (body.webhook_secret) await putSecret(WEBHOOK_SECRET_SECRET, body.webhook_secret)
    if (body.client_secret) await putSecret(CLIENT_SECRET_SECRET, body.client_secret)

    await db
      .insert(githubInstall)
      .values({
        id: 1,
        appId: String(body.id),
        appSlug: body.slug,
        orgLogin: body.owner?.type === 'Organization' ? body.owner.login : body.owner?.login ?? null,
        encryptedPrivateKeyRef: PRIVATE_KEY_SECRET,
        encryptedWebhookSecretRef: body.webhook_secret ? WEBHOOK_SECRET_SECRET : null,
        clientId: body.client_id ?? null,
        encryptedClientSecretRef: body.client_secret ? CLIENT_SECRET_SECRET : null,
      })
      .onConflictDoUpdate({
        target: githubInstall.id,
        set: {
          appId: String(body.id),
          appSlug: body.slug,
          orgLogin: body.owner?.login ?? null,
          encryptedPrivateKeyRef: PRIVATE_KEY_SECRET,
          encryptedWebhookSecretRef: body.webhook_secret ? WEBHOOK_SECRET_SECRET : null,
          clientId: body.client_id ?? null,
          encryptedClientSecretRef: body.client_secret ? CLIENT_SECRET_SECRET : null,
        },
      })

    this.installationTokenCache = null
    return { orgLogin: body.owner?.login ?? null, appSlug: body.slug }
  }

  async recordInstallation(installationId: string): Promise<void> {
    await db
      .update(githubInstall)
      .set({ installationId, installedAt: new Date() })
      .where(eq(githubInstall.id, 1))
    this.installationTokenCache = null
  }

  /**
   * Clear the install. Used when the operator wants to disconnect. Keeps the
   * private key encrypted at rest in case of re-connect.
   */
  async disconnect(): Promise<void> {
    await db.delete(githubInstall).where(eq(githubInstall.id, 1))
    this.installationTokenCache = null
  }

  private async loadPrivateKey(): Promise<string> {
    const pem = await getSecret(PRIVATE_KEY_SECRET)
    if (!pem) throw new GitHubError('not_connected', 'GitHub App not connected')
    return pem
  }

  /** Get a valid installation token. Caches until ~5 min before expiry. */
  async getInstallationToken(): Promise<string> {
    const row = await this.getRow()
    if (!row) throw new GitHubError('not_connected', 'GitHub App not connected')
    if (!row.installationId) {
      throw new GitHubError('not_installed', 'GitHub App not installed on any org')
    }

    if (this.installationTokenCache && this.installationTokenCache.expiresAt > Date.now() + 60_000) {
      return this.installationTokenCache.token
    }

    // Check DB cache too (survives restarts).
    const cached = await db
      .select()
      .from(githubTokenCache)
      .where(eq(githubTokenCache.installationId, row.installationId))
      .limit(1)
    const cachedRow = cached[0]
    if (cachedRow && cachedRow.expiresAt.getTime() > Date.now() + 60_000) {
      this.installationTokenCache = {
        token: cachedRow.token,
        expiresAt: cachedRow.expiresAt.getTime(),
      }
      return cachedRow.token
    }

    const pem = await this.loadPrivateKey()
    const jwt = signAppJwt(row.appId, pem)
    const res = await fetch(
      `https://api.github.com/app/installations/${row.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cloud-coding-env',
        },
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GitHubError(
        'token_mint_failed',
        `access_tokens returned ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    const body = (await res.json()) as { token: string; expires_at: string }
    const expiresAt = new Date(body.expires_at)
    this.installationTokenCache = { token: body.token, expiresAt: expiresAt.getTime() }
    await db
      .insert(githubTokenCache)
      .values({ installationId: row.installationId, token: body.token, expiresAt })
      .onConflictDoUpdate({
        target: githubTokenCache.installationId,
        set: { token: body.token, expiresAt },
      })
    return body.token
  }

  async listOrgRepos(): Promise<GitHubRepoSummary[]> {
    const token = await this.getInstallationToken()
    const out: GitHubRepoSummary[] = []
    let page = 1
    const maxPages = 10
    while (page <= maxPages) {
      const res = await fetch(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cloud-coding-env',
          },
        },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new GitHubError('api_error', `listing repos failed ${res.status}: ${text.slice(0, 200)}`)
      }
      const body = (await res.json()) as {
        total_count: number
        repositories: Array<{
          id: number
          name: string
          full_name: string
          private: boolean
          default_branch: string
          clone_url: string
          description: string | null
        }>
      }
      for (const r of body.repositories) {
        out.push({
          id: String(r.id),
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch,
          cloneUrl: r.clone_url,
          description: r.description,
        })
      }
      if (body.repositories.length < 100) break
      page++
    }
    return out
  }

  /**
   * Returns a clone URL with the installation token embedded. This is how
   * git clone authenticates. The token is short-lived; do not persist.
   */
  async buildAuthedCloneUrl(repoFullName: string): Promise<string> {
    const token = await this.getInstallationToken()
    return `https://x-access-token:${token}@github.com/${repoFullName}.git`
  }
}

export const githubService = new GitHubService()

// Expose for tests.
export const __githubInternals = { signAppJwt }
void logger
