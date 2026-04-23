import { router } from './trpc.js'
import { authRouter } from './routers/auth.js'
import { sandboxRouter } from './routers/sandbox.js'
import { fsRouter } from './routers/fs.js'
import { shellRouter } from './routers/shell.js'
import { repoRouter } from './routers/repo.js'
import { repoConfigRouter } from './routers/repo-config.js'
import { githubRouter } from './routers/github.js'
import { previewRouter } from './routers/preview.js'
import { jobRouter } from './routers/job.js'
import { agentRouter } from './routers/agent.js'
import { agentShellRouter } from './routers/agent-shell.js'
import { settingsRouter } from './routers/settings.js'

export const appRouter = router({
  auth: authRouter,
  sandbox: sandboxRouter,
  fs: fsRouter,
  shell: shellRouter,
  repo: repoRouter,
  repoConfig: repoConfigRouter,
  github: githubRouter,
  preview: previewRouter,
  job: jobRouter,
  agent: agentRouter,
  agentShell: agentShellRouter,
  settings: settingsRouter,
})

export type AppRouter = typeof appRouter
