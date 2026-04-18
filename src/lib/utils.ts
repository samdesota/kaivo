export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function extractTrpcMessage(err: unknown): string {
  if (err instanceof Error) {
    const maybe = err as unknown as { shape?: { message?: string }; message?: string }
    return maybe.shape?.message ?? maybe.message ?? 'unexpected error'
  }
  return 'unexpected error'
}
