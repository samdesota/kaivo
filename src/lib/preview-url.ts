import { trpc } from '../trpc'

export function usePreviewUrl(): (sandboxId: string, port: number) => string {
  const config = trpc.preview.config.useQuery(undefined, { staleTime: Infinity })
  const hostname = config.data?.hostname ?? null
  return (sandboxId, port) =>
    hostname
      ? `${window.location.protocol}//${sandboxId}-${port}.${hostname}/`
      : `/preview/${sandboxId}/${port}/`
}
