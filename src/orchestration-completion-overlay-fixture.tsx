import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { openTaskCompletionOverlay } from './lib/overlay-layer-controller'

function Fixture() {
  const [result, setResult] = useState('none')
  async function open() {
    const confirmed = await openTaskCompletionOverlay({
      env: { id: 'fixture-env', kind: 'local', url: 'http://127.0.0.1:1', label: 'Fixture env' },
      envToken: 'fixture-token',
      title: 'Implement parser',
      task: {
        deliveryMode: 'pull_request',
        branchName: 'task/parser',
        worktreePath: '/tmp/parser',
        delivery: { pullRequestUrl: 'https://github.com/acme/parser/pull/42', headCommit: 'abc123', summary: 'Ready' },
        completedAt: null,
      },
    })
    setResult(String(confirmed))
  }
  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <h1>Orchestration Completion Overlay Fixture</h1>
      <button type="button" onClick={() => void open()}>Open completion</button>
      <output aria-label="Completion result">{result}</output>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
