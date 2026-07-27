import { z } from 'zod'

export const AGENT_SESSION_KINDS = ['chat', 'dispatch', 'subtask'] as const
export type AgentSessionKind = (typeof AGENT_SESSION_KINDS)[number]

export const SUBTASK_STATES = ['provisioning', 'active', 'returned', 'completed', 'failed'] as const
export type SubtaskState = (typeof SUBTASK_STATES)[number]

export const DELIVERY_MODES = ['pull_request', 'dispatcher_integration'] as const
export type DeliveryMode = (typeof DELIVERY_MODES)[number]

export const PROVISIONING_STAGES = ['reserved', 'worktree_created', 'session_created', 'prompt_accepted'] as const
export type ProvisioningStage = (typeof PROVISIONING_STAGES)[number]

export const ARTIFACT_KINDS = ['worktree_path', 'repository_row', 'agent_session', 'opencode_session'] as const
export type ProvisioningArtifactKind = (typeof ARTIFACT_KINDS)[number]

export interface ProvisioningFailure {
  stage: string
  message: string
  retryable: boolean
  residualArtifacts: string[]
}

export interface SubtaskDelivery {
  pullRequestUrl: string | null
  headCommit: string | null
  summary: string | null
}

export const reportSubtaskDeliverySchema = z.object({
  pullRequestUrl: z.string().url().max(2_000).optional(),
  headCommit: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(4_000).optional(),
}).refine((value) => value.pullRequestUrl !== undefined || value.headCommit !== undefined || value.summary !== undefined, {
  message: 'at least one delivery field is required',
})

export type ReportSubtaskDeliveryInput = z.infer<typeof reportSubtaskDeliverySchema>

export const dispatchSubtaskSchema = z.object({
  operationId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  dispatchSessionId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(100_000),
  repositoryId: z.string().min(1).max(200),
  sourceRef: z.string().min(1).max(500),
  branchName: z.string().min(1).max(250),
  deliveryMode: z.enum(DELIVERY_MODES),
})

export type DispatchSubtaskInput = z.infer<typeof dispatchSubtaskSchema>

export const dispatchSubtaskFromAgentSchema = dispatchSubtaskSchema.omit({
  workspaceId: true,
  dispatchSessionId: true,
}).extend({ repositoryId: z.string().min(1).max(200).optional() })

export type DispatchSubtaskFromAgentInput = z.infer<typeof dispatchSubtaskFromAgentSchema>

export interface DispatchResult {
  subtaskId: string
  sessionId?: string
  state: SubtaskState
  worktreePath?: string
  failure?: ProvisioningFailure
}

export interface RepoConfigRequestSummary {
  id: string
  workspaceId: string
  workingDir: string
  repositoryRoot: string | null
  status: 'pending' | 'claimed'
  createdAt: string
}

export const ORCHESTRATION_RETURN_SUMMARY_MAX_CHARS = 500
export const DISPATCHER_CONTEXT_MAX_CHARS = 12_000

export interface OrchestrationReturn {
  id: string
  sequence: number
  subtaskId: string
  assistantMessageId: string
  kind: 'response' | 'error'
  summary: string
  createdAt: string
}

export interface OrchestrationCursor {
  generation: string
  seq: number
}

export type OrchestrationChange =
  | { type: 'changed'; cursor: OrchestrationCursor }
  | { type: 'stale'; cursor: OrchestrationCursor }

export interface OrchestrationSubtaskSummary {
  id: string
  dispatchSessionId: string
  sessionId: string | null
  sessionStatus: 'active' | 'archived' | null
  title: string
  state: SubtaskState
  provisioningStage: ProvisioningStage | null
  sourceRef: string
  branchName: string
  deliveryMode: DeliveryMode
  delivery: SubtaskDelivery
  worktreePath: string | null
  failure: ProvisioningFailure | null
  latestReturn: OrchestrationReturn | null
  running: boolean
  pendingAttentionCount: number
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface OrchestrationDispatchSummary {
  id: string
  title: string | null
  status: 'active' | 'archived'
  workingDir: string | null
  createdAt: string
  lastActivityAt: string
  subtasks: OrchestrationSubtaskSummary[]
}

export interface OrchestrationSnapshot {
  cursor: OrchestrationCursor
  dispatches: OrchestrationDispatchSummary[]
}
