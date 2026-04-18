import { router } from './trpc.js'
import { authRouter } from './routers/auth.js'
import { sandboxRouter } from './routers/sandbox.js'
import { fsRouter } from './routers/fs.js'
import { shellRouter } from './routers/shell.js'

export const appRouter = router({
  auth: authRouter,
  sandbox: sandboxRouter,
  fs: fsRouter,
  shell: shellRouter,
})

export type AppRouter = typeof appRouter
