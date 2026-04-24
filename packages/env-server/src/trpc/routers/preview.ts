import { observable } from '@trpc/server/observable'
import { authedProcedure, router } from '../trpc.js'
import { previewService, type PreviewPort } from '../../preview/service.js'

export const previewRouter = router({
  ports: authedProcedure.subscription(() => {
    return observable<{ ports: PreviewPort[] }>((emit) => {
      emit.next({ ports: previewService.getPorts() })
      const unsub = previewService.subscribe((evt) => emit.next(evt))
      return () => unsub()
    })
  }),

  portsSnapshot: authedProcedure.query(() => previewService.getPorts()),
})
