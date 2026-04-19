import type { PaneContent } from '../../shell/tab-state'
import type { Part, PermissionRequest, TranscriptState } from '../transcript-store'
import { permissionForCall } from '../transcript-store'
import { FilePart } from './file-part'
import { PatchPart } from './patch-part'
import { ReasoningPart } from './reasoning-part'
import { StepFinishPart } from './step-finish-part'
import { TextPart } from './text-part'
import { ToolPart } from './tool-part'

/** Parts we intentionally skip rendering. */
const HIDDEN = new Set(['step-start', 'snapshot'])

export function PartRenderer({
  part,
  state,
  role,
  sessionId,
  onOpenShell,
}: {
  part: Part
  state: TranscriptState
  role: string
  sessionId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  if (HIDDEN.has(part.type)) return null
  if ((part as { synthetic?: boolean }).synthetic) return null
  switch (part.type) {
    case 'text':
      return <TextPart part={part} role={role} />
    case 'reasoning':
      return <ReasoningPart part={part} />
    case 'tool': {
      const callID = (part as { callID?: string }).callID
      const perm: PermissionRequest | undefined = callID ? permissionForCall(state, callID) : undefined
      return (
        <ToolPart
          part={part}
          permission={perm}
          sessionId={sessionId}
          onOpenShell={onOpenShell}
        />
      )
    }
    case 'file':
      return <FilePart part={part} />
    case 'patch':
      return <PatchPart part={part} />
    case 'step-finish':
      return <StepFinishPart part={part} />
    default:
      return (
        <div className="text-[10px] italic text-neutral-600">
          unsupported part type: {part.type}
        </div>
      )
  }
}
