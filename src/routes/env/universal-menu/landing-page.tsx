import { UniversalMenuEmptyRow, UniversalMenuResultRow } from './shared'
import type { ScopeDefinition, UniversalMenuResult } from './types'

export interface UniversalMenuLandingSection {
  id: string
  label: string
  results: UniversalMenuResult[]
}

export function UniversalMenuLandingPage({
  scopes,
  sections,
  activeIndex,
  mouseMoved,
  onMouseMoved,
  onActiveChange,
  loadingFolders,
  onEnterScope,
  onSelect,
}: {
  scopes: ScopeDefinition[]
  sections: UniversalMenuLandingSection[]
  activeIndex: number
  mouseMoved: boolean
  onMouseMoved: () => void
  onActiveChange: (index: number) => void
  loadingFolders: boolean
  onEnterScope: (scope: ScopeDefinition) => void
  onSelect: (result: UniversalMenuResult, event?: { shiftKey?: boolean }) => void
}) {
  return (
    <>
      <div className="mx-3 mt-2 flex items-center justify-between gap-1">
        {scopes.map((scope) => <UniversalMenuScopeButton key={scope.id} scope={scope} onClick={() => onEnterScope(scope)} />)}
      </div>
      <UniversalMenuLandingSections
        sections={sections}
        activeIndex={activeIndex}
        mouseMoved={mouseMoved}
        onMouseMoved={onMouseMoved}
        onActiveChange={onActiveChange}
        loadingFolders={loadingFolders}
        onSelect={onSelect}
      />
    </>
  )
}

function UniversalMenuLandingSections({
  sections,
  activeIndex,
  mouseMoved,
  onMouseMoved,
  onActiveChange,
  loadingFolders,
  onSelect,
}: {
  sections: UniversalMenuLandingSection[]
  activeIndex: number
  mouseMoved: boolean
  onMouseMoved: () => void
  onActiveChange: (index: number) => void
  loadingFolders: boolean
  onSelect: (result: UniversalMenuResult, event?: { shiftKey?: boolean }) => void
}) {
  const hasRows = sections.some((section) => section.results.length > 0)
  let rowIndex = 0
  return (
    <div className="max-h-[54vh] overflow-y-auto py-2" data-testid="universal-menu-context-view">
      {sections.map((section) => (
        <section key={section.id} className="py-1">
          <div className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-neutral-600">{section.label}</div>
          <ul>
            {section.results.map((result) => {
              const index = rowIndex++
              return (
                <li key={result.id} onMouseMove={onMouseMoved}>
                  <UniversalMenuResultRow
                    result={result}
                    state={{
                      active: index === activeIndex,
                      disabled: !!result.disabled,
                      onMouseEnter: () => {
                        if (mouseMoved) onActiveChange(index)
                      },
                      onSelect: (event) => onSelect(result, event),
                      onAlternateSelect: () => undefined,
                    }}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {!hasRows && <UniversalMenuEmptyRow>{loadingFolders ? 'Loading workspace resources...' : 'No workspace resources are open yet.'}</UniversalMenuEmptyRow>}
    </div>
  )
}

function UniversalMenuScopeButton({ scope, onClick }: { scope: ScopeDefinition; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 items-center justify-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-neutral-925 hover:text-neutral-300"
    >
      <span className="rounded bg-neutral-900 px-1 py-0 font-mono text-[9px] leading-4 text-neutral-400">{scope.key}</span>
      <span className="truncate">{scope.label}</span>
    </button>
  )
}
