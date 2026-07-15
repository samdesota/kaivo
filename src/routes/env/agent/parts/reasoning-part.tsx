import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Part } from '../transcript-store'

const previewElements = ['p', 'strong', 'em', 'del', 'code']

export function ReasoningPart({ part }: { part: Part }) {
  const [open, setOpen] = useState(false)
  const text = (part as { text?: string }).text ?? ''
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full min-w-0 items-center gap-2 rounded py-0.5 text-left hover:bg-neutral-900/40"
      >
        <span className="inline-flex w-3 shrink-0 justify-center font-mono text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="shrink-0 italic text-neutral-400 group-hover:text-neutral-200">Thinking</span>
        {text && !open && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-600 group-hover:text-neutral-500">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              allowedElements={previewElements}
              unwrapDisallowed
              components={{ p: ({ children }) => <span>{children}</span> }}
            >
              {text}
            </ReactMarkdown>
          </span>
        )}
      </button>
      {open && (
        <div className="ml-[5px] border-l border-neutral-800 pl-3 pt-1 text-[12px] leading-snug text-neutral-500 [&_blockquote]:border-l [&_blockquote]:border-neutral-700 [&_blockquote]:pl-2 [&_code]:font-mono [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_strong]:font-semibold [&_ul]:list-disc">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}
