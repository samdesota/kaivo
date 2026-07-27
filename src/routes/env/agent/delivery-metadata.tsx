export type DeliveryMetadataValue = {
  deliveryMode: 'pull_request' | 'dispatcher_integration'
  branchName: string
  worktreePath: string | null
  delivery: {
    pullRequestUrl: string | null
    headCommit: string | null
    summary: string | null
  }
  completedAt: string | null
}

export function deliveryMetadataWarning(value: DeliveryMetadataValue): string | null {
  if (value.deliveryMode === 'pull_request' && !value.delivery.pullRequestUrl) {
    return 'This task expects an independent pull request, but no PR URL has been reported.'
  }
  if (value.deliveryMode === 'dispatcher_integration' && !value.delivery.headCommit) {
    return 'This task expects dispatcher integration, but no head commit has been reported.'
  }
  return null
}

export function DeliveryMetadata({ value, showWarning = false }: { value: DeliveryMetadataValue; showWarning?: boolean }) {
  const warning = deliveryMetadataWarning(value)
  return (
    <div className="space-y-1 text-[11px] text-neutral-400" aria-label="Delivery metadata">
      <div><span className="text-neutral-500">Delivery</span> {value.deliveryMode === 'pull_request' ? 'Independent PR' : 'Dispatcher integration'}</div>
      <div className="truncate"><span className="text-neutral-500">Branch</span> <code>{value.branchName}</code></div>
      {value.worktreePath && <div className="truncate"><span className="text-neutral-500">Worktree</span> <code>{value.worktreePath}</code></div>}
      {value.delivery.pullRequestUrl && <div className="truncate"><span className="text-neutral-500">PR</span> <a className="text-sky-300 hover:underline" href={value.delivery.pullRequestUrl}>{value.delivery.pullRequestUrl}</a></div>}
      {value.delivery.headCommit && <div className="truncate"><span className="text-neutral-500">Head</span> <code>{value.delivery.headCommit}</code></div>}
      {value.delivery.summary && <div className="whitespace-pre-wrap text-neutral-300">{value.delivery.summary}</div>}
      {value.completedAt && <div><span className="text-neutral-500">Completed</span> {new Date(value.completedAt).toLocaleString()}</div>}
      {showWarning && warning && <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-amber-300">{warning}</div>}
    </div>
  )
}
