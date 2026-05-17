import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { BrowserPane } from './components/browser-pane'
import type { BookmarkRecord } from './routes/workspace/bookmarks-store'

window.localStorage.setItem('__zoottle_mock_bookmark_mutations', 'true')
window.localStorage.removeItem('__zoottle_mock_bookmark_mutation_calls')

window.addEventListener('unhandledrejection', (event) => {
  window.localStorage.setItem('__zoottle_last_unhandled_rejection', String(event.reason?.message ?? event.reason))
})

const faviconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

const seededBookmarks: BookmarkRecord[] = [
  {
    id: 'seed-bookmark',
    workspaceId: 'workspace-e2e',
    title: 'Seed Bookmark',
    url: 'https://example.com/seed',
    normalizedUrl: 'https://example.com/seed',
    origin: 'https://example.com',
    faviconDataUrl,
    faviconUrl: 'https://example.com/favicon.ico',
    createdAt: new Date('2026-05-16T00:00:00Z'),
    updatedAt: new Date('2026-05-16T00:00:00Z'),
  },
]

function BrowserBookmarkFixture() {
  const [browserTabId, setBrowserTabId] = useState<string | undefined>(undefined)
  const [url, setUrl] = useState('https://example.com/docs')
  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <h1 className="p-3 text-sm">Browser Bookmark Fixture</h1>
      <section className="min-h-0 flex-1 border border-neutral-800" aria-label="Fixture pane">
        <BrowserPane
          paneId="bookmark-pane"
          workspaceId="workspace-e2e"
          url={url}
          title="Example Docs"
          browserTabId={browserTabId}
          faviconDataUrl={faviconDataUrl}
          faviconUrl="https://example.com/favicon.ico"
          bookmarks={seededBookmarks}
          active={true}
          closeOnUnmount={false}
          onBrowserTabId={setBrowserTabId}
          onUrlChange={setUrl}
        />
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<BrowserBookmarkFixture />)
