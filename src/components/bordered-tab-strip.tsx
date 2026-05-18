import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '../lib/utils'
import { TabIconView, type TabIcon } from './tab-icon'

export interface BorderedTabItem {
  id: string
  label: ReactNode
  icon?: TabIcon
  title?: string
  closeTitle?: string
}

export function BorderedTabStrip({
  items,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  onResort,
  focused = false,
  className,
}: {
  items: BorderedTabItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onContextMenu?: (id: string, event: MouseEvent) => void
  onResort?: (ids: string[]) => void
  focused?: boolean
  className?: string
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = items.map((item) => item.id)

  function handleDragEnd(event: DragEndEvent) {
    const overId = event.over?.id
    if (!overId || event.active.id === overId) return
    const from = ids.indexOf(String(event.active.id))
    const to = ids.indexOf(String(overId))
    if (from < 0 || to < 0) return
    onResort?.(arrayMove(ids, from, to))
  }

  const content = (
    <div
      role="tablist"
      className={cn(
        'no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden whitespace-nowrap',
        className,
      )}
    >
      {items.map((item) => (
        <BorderedTab
          key={item.id}
          item={item}
          active={item.id === activeId}
          focused={focused}
          sortable={Boolean(onResort)}
          onSelect={onSelect}
          onClose={onClose}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  )

  if (!onResort || items.length < 2) return content

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        {content}
      </SortableContext>
    </DndContext>
  )
}

function BorderedTab({
  item,
  active,
  focused,
  sortable,
  onSelect,
  onClose,
  onContextMenu,
}: {
  item: BorderedTabItem
  active: boolean
  focused: boolean
  sortable: boolean
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onContextMenu?: (id: string, event: MouseEvent) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !sortable })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      onContextMenu={onContextMenu ? (event) => onContextMenu(item.id, event) : undefined}
      className={cn(
        'group relative flex min-w-[100px] max-w-[250px] shrink-0 touch-none items-stretch border-l border-neutral-800 transition-colors first:border-l-0 last:border-r',
        active ? 'bg-highlight text-neutral-200' : 'text-neutral-400 hover:bg-highlight hover:text-neutral-200',
        isDragging && 'z-20 opacity-80 shadow-lg',
      )}
      style={style}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-neutral-400 transition-opacity',
          focused && active ? 'opacity-100' : 'opacity-0',
        )}
      />
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 pr-1 text-left text-xs"
        title={item.title}
      >
        {item.icon ? <TabIconView icon={item.icon} /> : null}
        <span className="block min-w-0 truncate align-middle">{item.label}</span>
      </button>
      {onClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClose(item.id)
          }}
          className="ml-auto flex w-7 items-center justify-center text-sm leading-none text-neutral-500 opacity-70 hover:text-neutral-100 hover:opacity-100"
          aria-label="Close tab"
          title={item.closeTitle ?? 'Close tab'}
        >
          ×
        </button>
      )}
    </div>
  )
}
