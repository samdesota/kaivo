import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Part } from '../transcript-store'

export function TextPart({ part, role }: { part: Part; role: string }) {
  const text = (part as { text?: string }).text ?? ''
  const running = !(part as { time?: { end?: number } }).time?.end
  const isAssistant = role !== 'user'

  if (!isAssistant) {
    return (
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">
        {text}
      </div>
    )
  }

  return (
    <div className="prose-agent text-sm leading-relaxed text-neutral-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
      {running && (
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
      )}
    </div>
  )
}

/**
 * Tailwind-utility-class map for the markdown elements we render. Keeping it
 * inline avoids pulling in @tailwindcss/typography just for the chat — the
 * chat's needs are narrow (paragraphs, lists, code, tables).
 */
const MD_COMPONENTS = {
  p: (p: { children?: React.ReactNode }) => (
    <p className="my-1.5 first:mt-0 last:mb-0">{p.children}</p>
  ),
  h1: (p: { children?: React.ReactNode }) => (
    <h1 className="mt-3 mb-1.5 text-base font-semibold text-neutral-100">{p.children}</h1>
  ),
  h2: (p: { children?: React.ReactNode }) => (
    <h2 className="mt-3 mb-1.5 text-sm font-semibold text-neutral-100">{p.children}</h2>
  ),
  h3: (p: { children?: React.ReactNode }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold text-neutral-200">{p.children}</h3>
  ),
  ul: (p: { children?: React.ReactNode }) => (
    <ul className="my-1.5 ml-5 list-disc space-y-0.5 marker:text-neutral-500">{p.children}</ul>
  ),
  ol: (p: { children?: React.ReactNode }) => (
    <ol className="my-1.5 ml-5 list-decimal space-y-0.5 marker:text-neutral-500">{p.children}</ol>
  ),
  li: (p: { children?: React.ReactNode }) => <li className="leading-snug">{p.children}</li>,
  a: (p: { href?: string; children?: React.ReactNode }) => (
    <a
      href={p.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand-400 underline hover:text-brand-300"
    >
      {p.children}
    </a>
  ),
  blockquote: (p: { children?: React.ReactNode }) => (
    <blockquote className="my-1.5 border-l-2 border-neutral-700 pl-3 text-neutral-300">
      {p.children}
    </blockquote>
  ),
  code: (p: { className?: string; children?: React.ReactNode; inline?: boolean }) => {
    // react-markdown v10 doesn't pass `inline`; treat as inline when not
    // wrapped by a `pre` (handled by the `pre` override). Heuristic: a code
    // node with no className is inline.
    if (!p.className) {
      return (
        <code className="rounded bg-neutral-800/80 px-1 py-0.5 font-mono text-[12px] text-neutral-100">
          {p.children}
        </code>
      )
    }
    return <code className={p.className}>{p.children}</code>
  },
  pre: (p: { children?: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 p-2 text-[12px] leading-snug text-neutral-200">
      {p.children}
    </pre>
  ),
  table: (p: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-xs">{p.children}</table>
    </div>
  ),
  th: (p: { children?: React.ReactNode }) => (
    <th className="border border-neutral-800 px-2 py-1 text-left font-medium text-neutral-200">
      {p.children}
    </th>
  ),
  td: (p: { children?: React.ReactNode }) => (
    <td className="border border-neutral-800 px-2 py-1 text-neutral-300">{p.children}</td>
  ),
  hr: () => <hr className="my-3 border-neutral-800" />,
  strong: (p: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-neutral-50">{p.children}</strong>
  ),
  em: (p: { children?: React.ReactNode }) => <em className="italic">{p.children}</em>,
}
