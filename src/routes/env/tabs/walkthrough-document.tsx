import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CanonicalDiff } from '../../../../packages/env-server/src/walkthrough/contracts'
import { partitionWalkthroughMarkdown } from './walkthrough-markdown'
import { WalkthroughDiffEmbed } from './walkthrough-diff-embed'

export function WalkthroughDocument({ markdown, canonical }: { markdown: string; canonical: CanonicalDiff }) {
  const [reviewerExpansion, setReviewerExpansion] = useState<Record<string, boolean>>({})
  const segments = partitionWalkthroughMarkdown(markdown, canonical)
  return (
    <div className="min-w-0 max-w-full">
      {segments.map((segment) => {
        if (segment.kind === 'markdown') return <ReactMarkdown key={`markdown:${segment.start}`} remarkPlugins={[remarkGfm]}>{segment.source}</ReactMarkdown>
        if (segment.kind === 'pending') return <div key={`pending:${segment.start}`} role="status" className="my-3 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-ui-muted">Receiving diff annotation...</div>
        if (segment.kind === 'unsupported') return <DirectiveError key={`unsupported:${segment.start}`} source={segment.source} message={`Unsupported kaivo-diff directive version: ${String(segment.version)}`} />
        if (segment.kind === 'error') return <DirectiveError key={`error:${segment.start}`} source={segment.source} message={segment.error} />
        const file = canonical.files[segment.directive.file.index]!
        const open = reviewerExpansion[segment.directive.id] ?? !segment.directive.collapsed
        return (
          <WalkthroughDiffEmbed
            key={`directive:${segment.directive.id}`}
            directive={segment.directive}
            file={file}
            open={open}
            onOpenChange={(next) => setReviewerExpansion((current) => ({ ...current, [segment.directive.id]: next }))}
          />
        )
      })}
    </div>
  )
}

function DirectiveError({ source, message }: { source: string; message: string }) {
  return (
    <div className="my-3 min-w-0 max-w-full">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      <div role="alert" className="rounded border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200">{message}</div>
    </div>
  )
}
