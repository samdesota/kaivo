import type { PaneContent } from '../../shell/tab-state'
import type { Part, SessionErrorPart, TranscriptState } from '../transcript-store'
import { ErrorPart } from './error-part'
import { FilePart } from './file-part'
import { PatchPart } from './patch-part'
import { ReasoningPart } from './reasoning-part'
import { TextPart } from './text-part'
import { ToolPart } from './tool-part'

export function PartRenderer({
  part,
  role,
  sessionId,
  workingDir,
  onOpenShell,
  childTranscript,
}: {
  part: Part
  role: string
  sessionId: string
  workingDir?: string
  onOpenShell?: (content: PaneContent) => void
  childTranscript?: TranscriptState
}) {
  switch (part.type) {
    case 'text':
      return (
        <TextPart
          part={part}
          role={role}
          onOpenBrowserPane={(url) => onOpenShell?.({ type: 'browser', url })}
        />
      )
    case 'reasoning':
      return <ReasoningPart part={part} />
    case 'tool': {
      return (
        <ToolPart
          part={part}
          sessionId={sessionId}
          workingDir={workingDir}
          onOpenShell={onOpenShell}
          childTranscript={childTranscript}
        />
      )
    }
    case 'file':
      return <FilePart part={part} />
    case 'patch':
      return <PatchPart part={part} />
    case 'session-error':
      return <ErrorPart part={part as SessionErrorPart} />
    default:
      return (
        <div className="text-[10px] italic text-neutral-600">
          unsupported part type: {part.type}
        </div>
      )
  }
}
