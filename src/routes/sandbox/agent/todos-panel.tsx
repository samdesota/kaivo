import { useEffect, useState } from 'react'
import type { TodoItem } from './transcript-store'

const STORAGE_KEY = 'sandbox.agent.todosPanel.collapsed'

/**
 * Fixed-width collapsible side panel showing the agent's current todo list.
 * Lives to the right of the chat. Opens the moment any todos exist (so the
 * user notices), but the user can manually collapse and the choice sticks
 * across sessions.
 */
export function TodosPanel({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  })

  // Auto-open when the agent first creates a todo list. Manual collapse still
  // wins on subsequent updates because we only flip-on, never flip-off.
  const [seenAny, setSeenAny] = useState(false)
  useEffect(() => {
    if (todos.length > 0 && !seenAny) {
      setSeenAny(true)
      if (window.localStorage.getItem(STORAGE_KEY) !== '1') setCollapsed(false)
    }
  }, [todos.length, seenAny])

  function toggle() {
    setCollapsed((c) => {
      const next = !c
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }

  if (todos.length === 0 && collapsed) return null

  if (collapsed) {
    return (
      <button
        onClick={toggle}
        title={`${todos.length} todo${todos.length === 1 ? '' : 's'}`}
        className="flex w-7 shrink-0 flex-col items-center justify-start gap-2 border-l border-neutral-800 bg-neutral-950 py-3 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
      >
        <span style={{ writingMode: 'vertical-rl' }}>Todos · {todos.length}</span>
      </button>
    )
  }

  const counts = countByStatus(todos)
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-300">Todos</h3>
          <span className="text-[10px] text-neutral-500">
            {counts.completed}/{todos.length}
          </span>
        </div>
        <button
          onClick={toggle}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
          title="Collapse"
        >
          →
        </button>
      </header>
      {todos.length === 0 ? (
        <div className="p-3 text-xs text-neutral-500">No todos yet.</div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto p-2">
          {todos.map((t) => (
            <TodoRow key={t.id} todo={t} />
          ))}
        </ul>
      )}
    </aside>
  )
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const isDone = todo.status === 'completed'
  const isActive = todo.status === 'in_progress'
  const isCancelled = todo.status === 'cancelled'
  return (
    <li className="flex items-start gap-2 px-1 py-1.5">
      <StatusGlyph status={todo.status} />
      <div className="min-w-0 flex-1">
        <div
          className={
            'text-xs leading-snug ' +
            (isDone
              ? 'text-neutral-500 line-through'
              : isCancelled
                ? 'text-neutral-600 line-through'
                : isActive
                  ? 'text-neutral-100'
                  : 'text-neutral-300')
          }
        >
          {todo.content}
        </div>
        {todo.priority && todo.priority !== 'medium' && (
          <div
            className={
              'mt-0.5 text-[10px] uppercase tracking-wide ' +
              (todo.priority === 'high' ? 'text-amber-400' : 'text-neutral-500')
            }
          >
            {todo.priority}
          </div>
        )}
      </div>
    </li>
  )
}

function StatusGlyph({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-emerald-500/60 bg-emerald-500/20 text-[9px] text-emerald-300">
        ✓
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-sky-400 bg-sky-500/30">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
      </span>
    )
  }
  if (status === 'cancelled') {
    return (
      <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-[9px] text-neutral-600">
        ×
      </span>
    )
  }
  return (
    <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-600" />
  )
}

function countByStatus(todos: TodoItem[]) {
  let completed = 0
  for (const t of todos) if (t.status === 'completed') completed++
  return { completed }
}
