import { router } from './trpc.js'
import { metaRouter } from './routers/meta.js'
import { pairRouter } from './routers/pair.js'
import { shellRouter } from './routers/shell.js'
import { fsRouter } from './routers/fs.js'
import { repoRouter } from './routers/repo.js'
import { jobRouter } from './routers/job.js'
import { agentRouter } from './routers/agent.js'
import { agentShellRouter } from './routers/agent-shell.js'
import { agentBrowserRouter } from './routers/agent-browser.js'
import { agentUiRouter } from './routers/agent-ui.js'
import { previewRouter } from './routers/preview.js'
import { syncRouter } from './routers/sync.js'

export const appRouter = router({
  meta: metaRouter,
  pair: pairRouter,
  shell: shellRouter,
  fs: fsRouter,
  repo: repoRouter,
  job: jobRouter,
  agent: agentRouter,
  agentShell: agentShellRouter,
  agentBrowser: agentBrowserRouter,
  agentUi: agentUiRouter,
  preview: previewRouter,
  sync: syncRouter,
})

export type AppRouter = typeof appRouter
