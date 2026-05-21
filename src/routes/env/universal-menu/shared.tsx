import { EllipsisVertical } from 'lucide-react'
import { TabIconView } from '../../../components/tab-icon'
import type { UniversalMenuRenderState, UniversalMenuResult, UniversalMenuResultAction } from './types'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export function UniversalMenuResultList({
  results,
  activeIndex,
  mouseMoved = true,
  onMouseMoved,
  loading = false,
  onActiveChange,
  onSelect,
  onAlternateSelect,
  actionMenuIndex = null,
  onOpenActions,
  onRunAction,
  renderResult,
}: {
  results: UniversalMenuResult[]
  activeIndex: number
  mouseMoved?: boolean
  onMouseMoved?: () => void
  loading?: boolean
  onActiveChange: (index: number) => void
  onSelect: (index: number, event?: { shiftKey?: boolean }) => void
  onAlternateSelect?: (index: number) => void
  actionMenuIndex?: number | null
  onOpenActions?: (index: number) => void
  onRunAction?: (action: UniversalMenuResultAction) => void
  renderResult?: (result: UniversalMenuResult, state: UniversalMenuRenderState) => ReactNode
}) {
  if (results.length === 0) return <UniversalMenuEmptyRow>No matches.</UniversalMenuEmptyRow>
  return (
    <ul
      className={`max-h-[54vh] overflow-y-auto py-1 ${loading ? 'animate-[universal-menu-loading-dim_160ms_120ms_forwards]' : ''}`}
      data-testid="universal-menu-results"
    >
      {results.map((result, index) => {
        const state: UniversalMenuRenderState = {
          active: index === activeIndex,
          disabled: !!result.disabled,
          onMouseEnter: () => {
            if (mouseMoved) onActiveChange(index)
          },
          onSelect: (event) => onSelect(index, event),
          onAlternateSelect: () => onAlternateSelect?.(index),
          actionMenuOpen: actionMenuIndex === index,
          onOpenActions: () => onOpenActions?.(index),
          onRunAction: (action) => onRunAction?.(action),
        }
        return (
          <li key={result.id} onMouseMove={onMouseMoved}>
            {renderResult
              ? renderResult(result, state)
              : result.depth !== undefined
                ? <UniversalMenuHierarchyRow result={result} state={state} />
                : <UniversalMenuResultRow result={result} state={state} />}
          </li>
        )
      })}
    </ul>
  )
}

export function UniversalMenuResultRow({ result, state }: { result: UniversalMenuResult; state: UniversalMenuRenderState }) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const detailNode = result.actionHint ? undefined : result.detailNode
  const showActions = state.active && !!result.actions?.length
  return (
    <div ref={rowRef} onMouseEnter={state.onMouseEnter} className="relative">
      <button
        type="button"
        disabled={state.disabled}
        onClick={(event) => state.onSelect(event)}
        className={`${rowClassName(state)} ${showActions ? 'pr-10' : ''}`}
      >
        {result.icon && <TabIconView icon={result.icon} />}
        <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
        {detailNode ? <span className="hidden max-w-[48%] truncate text-[11px] text-neutral-500 sm:block">{detailNode}</span> : detail && <span className="hidden max-w-[48%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
      </button>
      {showActions && (
        <button
          type="button"
          aria-label={`Actions for ${result.label}`}
          onClick={(event) => {
            event.stopPropagation()
            state.onOpenActions()
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
        >
          <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {state.actionMenuOpen && result.actions?.length ? <UniversalMenuActionMenu anchorRef={rowRef} actions={result.actions} onRunAction={state.onRunAction} /> : null}
    </div>
  )
}

export function UniversalMenuHierarchyRow({ result, state }: { result: UniversalMenuResult; state: UniversalMenuRenderState }) {
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const detailNode = result.actionHint ? undefined : result.detailNode
  return (
    <button
      type="button"
      disabled={state.disabled}
      onMouseEnter={state.onMouseEnter}
      onClick={(event) => state.onSelect(event)}
      className={rowClassName(state)}
      style={{ paddingLeft: result.flatHierarchy ? 16 : `${16 + (result.depth ?? 0) * 18}px` }}
    >
      {result.icon && <TabIconView icon={result.icon} />}
      <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
      {detailNode ? <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detailNode}</span> : detail && <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
    </button>
  )
}

function UniversalMenuActionMenu({ anchorRef, actions, onRunAction }: { anchorRef: RefObject<HTMLElement | null>; actions: UniversalMenuResultAction[]; onRunAction: (action: UniversalMenuResultAction) => void }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    function updatePosition() {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      setPosition({
        left: Math.max(8, rect.right - 184),
        top: rect.bottom + 4,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef])

  if (!position || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed z-[70] w-44 rounded border border-neutral-800 bg-neutral-975 p-1 shadow-lg" style={position} role="menu">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={(event) => {
            event.stopPropagation()
            onRunAction(action)
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-900"
        >
          <span className="rounded bg-neutral-900 px-1 font-mono text-[10px] uppercase text-neutral-400">{action.key}</span>
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

export function UniversalMenuEmptyRow({ children }: { children: ReactNode }) {
  return <div className="px-4 py-4 text-sm text-neutral-500">{children}</div>
}

export function CompactPath({ path }: { path: string }) {
  const homePrefix = path.startsWith('~/') ? '~' : path === '~' ? '~' : ''
  const trimmed = homePrefix ? path.slice(homePrefix.length).replace(/^\/+/, '') : path.replace(/^\/+/, '')
  const absolutePrefix = !homePrefix && path.startsWith('/') ? '/' : ''
  const parts = trimmed.split('/').filter(Boolean)
  return (
    <span className="inline-flex min-w-0 items-center truncate font-mono text-neutral-700">
      {homePrefix && <span className="truncate">{homePrefix}</span>}
      {absolutePrefix && <span className="text-neutral-700">/</span>}
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex min-w-0 items-center">
          {(homePrefix || absolutePrefix || index > 0) && <span className="px-0.5 text-neutral-700">/</span>}
          <span className="truncate">{part}</span>
        </span>
      ))}
    </span>
  )
}

export function rowClassName(state: UniversalMenuRenderState): string {
  const base = 'flex w-full items-center gap-3 px-4 py-2 text-sm'
  if (state.disabled) return `${base} cursor-default text-neutral-600`
  return `${base} cursor-pointer ${state.active ? 'bg-highlight text-neutral-100' : 'text-neutral-300'}`
}

export function selectResult(results: UniversalMenuResult[], index: number, onClose: () => void, event?: { shiftKey?: boolean }) {
  const result = results[index]
  if (!result || result.disabled) return
  if (event?.shiftKey && result.alternateRun) return Promise.resolve(result.alternateRun())
  return Promise.resolve(result.run()).then(() => {
    if (!result.keepOpen) onClose()
  })
}
