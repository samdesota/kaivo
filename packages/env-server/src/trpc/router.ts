import { router } from './trpc.js'
import { metaRouter } from './routers/meta.js'
import { pairRouter } from './routers/pair.js'
import { shellRouter } from './routers/shell.js'
import { fsRouter } from './routers/fs.js'
import { repoRouter } from './routers/repo.js'
import { jobRouter } from './routers/job.js'

export const appRouter = router({
  meta: metaRouter,
  pair: pairRouter,
  shell: shellRouter,
  fs: fsRouter,
  repo: repoRouter,
  job: jobRouter,
})

export type AppRouter = typeof appRouter
