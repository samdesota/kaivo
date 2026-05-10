import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Part } from '../transcript-store'
import type { MouseEvent, ReactNode } from 'react'

export function TextPart({
  part,
  role,
  onOpenBrowserPane,
}: {
  part: Part
  role: string
  onOpenBrowserPane?: (url: string) => void
}) {
  const text = (part as { text?: string }).text ?? ''
  const running = !(part as { time?: { end?: number } }).time?.end
  const isAssistant = role !== 'user'

  if (!isAssistant) {
    return (
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-content-default">
        {text}
      </div>
    )
  }

  return (
    <div className="prose-agent text-sm leading-relaxed text-content-strong">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents(onOpenBrowserPane)}>
        {text}
      </ReactMarkdown>
      {running && (
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
      )}
    </div>
  )
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function isBrowserPaneHref(href: string): boolean {
  const trimmed = href.trim()
  if (!trimmed) return false
  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  if (!protocolMatch) return true
  const protocol = protocolMatch[1]?.toLowerCase()
  return protocol === 'http' || protocol === 'https'
}

function toBrowserPaneUrl(href: string): string {
  const trimmed = href.trim()
  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  if (protocolMatch) return trimmed
  if (typeof window === 'undefined') return trimmed
  try {
    return new URL(trimmed, window.location.href).href
  } catch {
    return trimmed
  }
}

function createMarkdownComponents(onOpenBrowserPane?: (url: string) => void) {
  return {
    p: (p: { children?: ReactNode }) => (
      <p className="my-1.5 first:mt-0 last:mb-0">{p.children}</p>
    ),
    h1: (p: { children?: ReactNode }) => (
      <h1 className="mt-3 mb-1.5 text-base font-semibold text-header-1">{p.children}</h1>
    ),
    h2: (p: { children?: ReactNode }) => (
      <h2 className="mt-3 mb-1.5 text-sm font-semibold text-header-2">{p.children}</h2>
    ),
    h3: (p: { children?: ReactNode }) => (
      <h3 className="mt-2 mb-1 text-sm font-semibold text-header-3">{p.children}</h3>
    ),
    ul: (p: { children?: ReactNode }) => (
      <ul className="my-1.5 ml-5 list-disc space-y-0.5 marker:text-ui-muted">{p.children}</ul>
    ),
    ol: (p: { children?: ReactNode }) => (
      <ol className="my-1.5 ml-5 list-decimal space-y-0.5 marker:text-ui-muted">{p.children}</ol>
    ),
    li: (p: { children?: ReactNode }) => <li className="leading-snug">{p.children}</li>,
    a: (p: { href?: string; children?: ReactNode }) => {
      const href = p.href ?? ''
      const opensInPane = Boolean(onOpenBrowserPane && isBrowserPaneHref(href))
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!onOpenBrowserPane || !isPlainLeftClick(event) || !isBrowserPaneHref(href)) return
            event.preventDefault()
            onOpenBrowserPane(toBrowserPaneUrl(href))
          }}
          className="text-content-default underline hover:text-content-default"
          title={opensInPane ? 'Open in browser pane' : undefined}
        >
          {p.children}
        </a>
      )
    },
    blockquote: (p: { children?: ReactNode }) => (
      <blockquote className="my-1.5 border-l-2 border-neutral-700 pl-3 text-content-default">
        {p.children}
      </blockquote>
    ),
    code: (p: { className?: string; children?: ReactNode; inline?: boolean }) => {
      if (!p.className) {
        return (
          <code className="rounded bg-neutral-800/80 px-1 py-0.5 font-mono text-[12px] text-content-strong">
            {p.children}
          </code>
        )
      }
      return <code className={p.className}>{p.children}</code>
    },
    pre: (p: { children?: ReactNode }) => (
      <pre className="my-2 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 p-2 text-[12px] leading-snug text-header-3">
        {p.children}
      </pre>
    ),
    table: (p: { children?: ReactNode }) => (
      <div className="my-2 overflow-x-auto">
        <table className="border-collapse text-xs">{p.children}</table>
      </div>
    ),
    th: (p: { children?: ReactNode }) => (
      <th className="border border-neutral-800 px-2 py-1 text-left font-medium text-header-3">
        {p.children}
      </th>
    ),
    td: (p: { children?: ReactNode }) => (
      <td className="border border-neutral-800 px-2 py-1 text-content-default">{p.children}</td>
    ),
    hr: () => <hr className="my-3 border-neutral-800" />,
    strong: (p: { children?: ReactNode }) => (
      <strong className="font-semibold text-header-1">{p.children}</strong>
    ),
    em: (p: { children?: ReactNode }) => <em className="italic">{p.children}</em>,
  }
}
