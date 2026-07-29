import { ulid } from 'ulid'
import { agentService } from '../agent/service.js'
import { config } from '../config.js'
import { GitError, gitService, type GitDiffResult, type GitService } from '../git/service.js'
import {
  closedWalkthroughDirectiveFences,
  parseWalkthroughDirective,
  resolveWalkthroughDirective,
} from '../../../../shared/walkthrough-directive.js'
import type {
  CanonicalDiff,
  GitDiffComparison,
  ResolvedGitDiffComparison,
  WalkthroughEvent,
  WalkthroughModelSelection,
  WalkthroughSnapshot,
} from './contracts.js'
import type { WalkthroughModelRunner } from './model-runner.js'
import { openCodeWalkthroughModelRunner } from './opencode-model-runner.js'
import { parseCanonicalDiff, WalkthroughParseError } from './parser.js'
import { buildGenerationMessages, generationInputByteCount } from './prompt.js'
import { WalkthroughRepository, walkthroughRepository } from './repository.js'

export type WalkthroughErrorCode =
  | 'not_found'
  | 'invalid_comparison'
  | 'empty'
  | 'truncated'
  | 'oversized'
  | 'unsupported'
  | 'malformed'
  | 'git_error'
  | 'model_error'
  | 'model_refusal'
  | 'output_oversized'

export class WalkthroughError extends Error {
  constructor(public readonly code: WalkthroughErrorCode, message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'WalkthroughError'
  }
}

interface GitSnapshotSource {
  originBranches(cwd: string): ReturnType<GitService['originBranches']>
  diff(input: Parameters<GitService['diff']>[0]): Promise<GitDiffResult>
}

export interface WalkthroughServiceOptions {
  git?: GitSnapshotSource
  repository?: WalkthroughRepository
  runner?: WalkthroughModelRunner
  resolveModel?: () => WalkthroughModelSelection
  maxPatchBytes?: number
  maxInputBytes?: number
  eventChunkBytes?: number
  eventFlushMs?: number
  maxOutputBytes?: number
}

export interface StartWalkthroughInput {
  requestKey: string
  cwd: string
  comparison: GitDiffComparison
}

function prefixByUtf8Bytes(value: string, maxBytes: number): { head: string; tail: string } {
  let bytes = 0
  let end = 0
  for (const character of value) {
    const next = Buffer.byteLength(character)
    if (bytes + next > maxBytes && end > 0) break
    bytes += next
    end += character.length
    if (bytes >= maxBytes) break
  }
  return { head: value.slice(0, end), tail: value.slice(end) }
}

export function directiveCoverage(diff: CanonicalDiff, markdown: string): { covered: Set<string>; invalid: boolean } {
  const covered = new Set<string>()
  const ids = new Set<string>()
  let invalid = false
  const fences = closedWalkthroughDirectiveFences(markdown)
  for (const fence of fences) {
    const parsed = parseWalkthroughDirective(fence.body)
    if (parsed.kind !== 'valid' || ids.has(parsed.directive.id)) {
      invalid = true
      continue
    }
    ids.add(parsed.directive.id)
    const resolved = resolveWalkthroughDirective(diff, parsed.directive)
    if (!resolved.ok) {
      invalid = true
      continue
    }
    for (const unit of resolved.unitIds) covered.add(unit)
  }
  const openings = markdown.match(/^ {0,3}(?:`{3,}|~{3,})kaivo-diff[\t ]*(?:\r?$)/gm)?.length ?? 0
  if (openings !== fences.length) invalid = true
  return { covered, invalid }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Walkthrough model generation failed'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export class WalkthroughService {
  private readonly git: GitSnapshotSource
  private readonly repository: WalkthroughRepository
  private readonly runner: WalkthroughModelRunner
  private readonly resolveModel: () => WalkthroughModelSelection
  private readonly maxPatchBytes?: number
  private readonly maxInputBytes: number
  private readonly eventChunkBytes: number
  private readonly eventFlushMs: number
  private readonly maxOutputBytes: number
  private readonly active = new Map<string, AbortController>()

  constructor(options: WalkthroughServiceOptions = {}) {
    this.git = options.git ?? gitService
    this.repository = options.repository ?? walkthroughRepository
    this.runner = options.runner ?? openCodeWalkthroughModelRunner
    this.resolveModel = options.resolveModel ?? (() => ({ ...agentService.getDefaultModel(), variant: null }))
    this.maxPatchBytes = options.maxPatchBytes
    this.maxInputBytes = options.maxInputBytes ?? config.CC_WALKTHROUGH_MAX_INPUT_BYTES
    this.eventChunkBytes = options.eventChunkBytes ?? config.CC_WALKTHROUGH_EVENT_CHUNK_BYTES
    this.eventFlushMs = options.eventFlushMs ?? config.CC_WALKTHROUGH_EVENT_FLUSH_MS
    this.maxOutputBytes = options.maxOutputBytes ?? config.CC_WALKTHROUGH_MAX_OUTPUT_BYTES
  }

  private async acquire(cwd: string, comparison: GitDiffComparison): Promise<{
    comparison: ResolvedGitDiffComparison
    git: GitDiffResult
  }> {
    if (comparison.kind === 'working-tree') {
      return { comparison, git: await this.git.diff({ cwd, kind: 'working-tree' }) }
    }
    let originBranch = comparison.originBranch
    if (!originBranch) {
      const origins = await this.git.originBranches(cwd)
      originBranch = origins.defaultBranch?.name ?? null
      if (!originBranch) throw new WalkthroughError('invalid_comparison', 'repository has no default origin branch')
    }
    const resolved: ResolvedGitDiffComparison = {
      kind: 'branch',
      originBranch,
      includeUncommitted: comparison.includeUncommitted,
    }
    return {
      comparison: resolved,
      git: await this.git.diff({ cwd, kind: 'branch', originBranch, includeUncommitted: comparison.includeUncommitted }),
    }
  }

  async start(input: StartWalkthroughInput): Promise<{ walkthroughId: string }> {
    const existing = this.repository.findIdByRequestKey(input.requestKey)
    if (existing) return { walkthroughId: existing }
    try {
      const acquired = await this.acquire(input.cwd, input.comparison)
      const canonical = parseCanonicalDiff(acquired.git.patch, {
        maxBytes: this.maxPatchBytes,
        truncated: acquired.git.truncated,
      })
      const messages = buildGenerationMessages(canonical)
      const inputBytes = generationInputByteCount(messages)
      if (inputBytes > this.maxInputBytes) {
        throw new WalkthroughError(
          'oversized',
          `Walkthrough input is too large (${formatBytes(inputBytes)}; limit ${formatBytes(this.maxInputBytes)}). Narrow the comparison before generating.`,
        )
      }
      const model = this.resolveModel()
      const result = this.repository.createQueued({
        id: ulid().toLowerCase(),
        requestKey: input.requestKey,
        cwd: input.cwd,
        comparison: acquired.comparison,
        git: acquired.git,
        canonical,
        model,
      })
      if (result.created) {
        const controller = new AbortController()
        this.active.set(result.snapshot.id, controller)
        void this.generate(result.snapshot.id, canonical, model, messages, controller)
      }
      return { walkthroughId: result.snapshot.id }
    } catch (error) {
      if (error instanceof WalkthroughError) throw error
      if (error instanceof WalkthroughParseError) throw new WalkthroughError(error.code, error.message, error)
      if (error instanceof GitError) throw new WalkthroughError('git_error', error.message, error)
      throw error
    }
  }

  private async generate(
    id: string,
    canonical: CanonicalDiff,
    model: WalkthroughModelSelection,
    messages: ReturnType<typeof buildGenerationMessages>,
    controller: AbortController,
  ): Promise<void> {
    let buffer = ''
    let acceptedBytes = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const clearFlushTimer = () => {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
    }
    const flush = (force: boolean) => {
      clearFlushTimer()
      while (buffer && (force || Buffer.byteLength(buffer) >= this.eventChunkBytes)) {
        const part = prefixByUtf8Bytes(buffer, this.eventChunkBytes)
        if (!part.head) break
        buffer = part.tail
        const current = this.repository.snapshot(id)
        const covered = current ? directiveCoverage(canonical, current.markdown + part.head).covered.size : 0
        const snapshot = this.repository.appendMarkdown(id, part.head, covered)
        if (!snapshot || snapshot.status === 'cancelled' || snapshot.status === 'failed') {
          buffer = ''
          return
        }
        if (!force && Buffer.byteLength(buffer) < this.eventChunkBytes) break
      }
      if (buffer && !force) {
        flushTimer = setTimeout(() => flush(true), this.eventFlushMs)
        flushTimer.unref?.()
      }
    }
    const append = (delta: string) => {
      const bytes = Buffer.byteLength(delta)
      if (acceptedBytes + bytes > this.maxOutputBytes) {
        throw new WalkthroughError('output_oversized', `walkthrough output exceeds ${this.maxOutputBytes} bytes`)
      }
      acceptedBytes += bytes
      buffer += delta
      if (Buffer.byteLength(buffer) >= this.eventChunkBytes) flush(false)
      else if (!flushTimer) {
        flushTimer = setTimeout(() => flush(true), this.eventFlushMs)
        flushTimer.unref?.()
      }
    }

    try {
      this.repository.transition(id, 'thinking')
      let finished = false
      let streaming = false
      for await (const event of this.runner.run({
        cwd: this.snapshot(id).repository.root,
        model,
        messages,
        signal: controller.signal,
      })) {
        const current = this.repository.snapshot(id)
        if (!current || terminalStatuses.has(current.status)) break
        if (event.type === 'session') {
          this.repository.setRunnerSession(id, event.sessionId)
        } else if (event.type === 'text-delta') {
          if (!streaming) {
            this.repository.transition(id, 'streaming')
            streaming = true
          }
          append(event.delta)
        } else if (event.type === 'finish') {
          finished = true
          break
        }
      }
      flush(true)
      if (this.repository.snapshot(id)?.status === 'cancelled') return
      if (!finished) throw new WalkthroughError('model_error', 'model stream ended without a finish event')
      this.repository.transition(id, 'checking')
      const snapshot = this.snapshot(id)
      const coverage = directiveCoverage(canonical, snapshot.markdown)
      this.repository.setCoverage(id, coverage.covered.size)
      if (!snapshot.markdown.trim() || coverage.covered.size === 0) {
        throw new WalkthroughError('model_refusal', 'model did not produce a walkthrough with valid directives')
      }
      if (coverage.invalid || coverage.covered.size !== canonical.unitIds.length) {
        throw new WalkthroughError('model_error', 'model output did not validly cover the complete diff')
      }
      this.repository.complete(id, coverage.covered.size)
    } catch (error) {
      flush(true)
      if (this.repository.snapshot(id)?.status !== 'cancelled') this.repository.fail(id, message(error))
    } finally {
      clearFlushTimer()
      if (this.active.get(id) === controller) this.active.delete(id)
    }
  }

  snapshot(walkthroughId: string): WalkthroughSnapshot {
    const snapshot = this.repository.snapshot(walkthroughId)
    if (!snapshot) throw new WalkthroughError('not_found', 'walkthrough not found')
    return snapshot
  }

  events(walkthroughId: string, afterSequence: number): WalkthroughEvent[] {
    if (!this.repository.snapshot(walkthroughId)) throw new WalkthroughError('not_found', 'walkthrough not found')
    return this.repository.events(walkthroughId, afterSequence)
  }

  subscribe(walkthroughId: string, listener: (event: WalkthroughEvent) => void): () => void {
    if (!this.repository.snapshot(walkthroughId)) throw new WalkthroughError('not_found', 'walkthrough not found')
    return this.repository.subscribe(walkthroughId, listener)
  }

  cancel(walkthroughId: string): void {
    if (!this.repository.cancel(walkthroughId)) throw new WalkthroughError('not_found', 'walkthrough not found')
    this.active.get(walkthroughId)?.abort()
  }
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])
export const walkthroughService = new WalkthroughService()
