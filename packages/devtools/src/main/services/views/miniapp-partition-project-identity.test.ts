/**
 * Per-project identity for miniapp session partitions.
 *
 * Guards the contract that `miniappPartitionKey` / `miniappPartition` accept an
 * optional `projectPath` second argument and use it to distinguish otherwise
 * identical `appId`s launched from different filesystem paths — so opening the
 * same miniapp package from two directories never cross-contaminates storage.
 *
 * Backward-compatibility: callers that omit `projectPath` continue to get the
 * same `persist:miniapp-<appIdKey>` they always got, so no existing session
 * data is orphaned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// miniapp-partition.ts imports electron at module level for session helpers.
// Mock it before the module is imported so the pure key functions stay testable
// without a real Electron runtime.
vi.mock('electron', () => ({
  session: { fromPartition: (_p: string) => ({}) },
}))

import {
  miniappPartition as _miniappPartition,
  miniappPartitionKey as _miniappPartitionKey,
	miniappFileScope as _miniappFileScope,
  SHARED_MINIAPP_PARTITION,
  __resetMiniappSessionConfigForTests,
} from '../../../../../dimina-electron-runtime/src/main/services/views/miniapp-partition'

// Cast to the intended future signature (second arg is optional `projectPath`).
// The current implementation accepts only one argument, so TypeScript rejects
// two-arg calls. These casts let the tests compile and run so they can fail at
// RUNTIME — the correct failure mode for a missing feature, not a compile-time
// block. Remove the casts once the implementation is updated.
const miniappPartition = _miniappPartition as (
  appId: string | null | undefined,
  projectPath?: string,
) => string

const miniappPartitionKey = _miniappPartitionKey as (
  appId: string,
  projectPath?: string,
) => string
const miniappFileScope = _miniappFileScope as (partition: string) => string | null

beforeEach(() => {
  __resetMiniappSessionConfigForTests()
})

const APP_ID = 'wxappTESTIDabcdef'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Different projectPath → different partition (even for the same appId)
// ─────────────────────────────────────────────────────────────────────────────
describe('project-path isolation: same appId, different paths', () => {
	it('keeps the documented djb2 collision pair in distinct SHA-256 partitions and scopes', () => {
		const a = miniappPartition(APP_ID, 'project-gro2pmq0xgl')
		const b = miniappPartition(APP_ID, 'project-41e6z24uzsa')
		expect(a).not.toBe(b)
		expect(miniappFileScope(a)).not.toBe(miniappFileScope(b))
	})

	it('derives scope only from valid partitions', () => {
		expect(miniappFileScope(SHARED_MINIAPP_PARTITION)).toBe('shared')
		const partition = miniappPartition(APP_ID, '/scope-project')
		expect(miniappFileScope(partition)).toBe(miniappPartitionKey(APP_ID, '/scope-project'))
		expect(miniappFileScope('persist:miniapp-../escape')).toBeNull()
		expect(miniappFileScope('persist:other-a')).toBeNull()
	})
  it('produces distinct persist:miniapp- partitions for two different project paths', () => {
    // Without this contract an app opened from /a and /b would share cookies /
    // localStorage / cache and corrupt each other's data.
    const partA = miniappPartition(APP_ID, '/projects/alpha')
    const partB = miniappPartition(APP_ID, '/projects/beta')

    expect(partA).toMatch(/^persist:miniapp-/)
    expect(partB).toMatch(/^persist:miniapp-/)
    // If the implementation ignores projectPath, both resolve to the same key
    // and this assertion fails — that's the bug this test catches.
    expect(partA).not.toBe(partB)
  })

  it('miniappPartitionKey mirrors the isolation when projectPath differs', () => {
    const keyA = miniappPartitionKey(APP_ID, '/projects/alpha')
    const keyB = miniappPartitionKey(APP_ID, '/projects/beta')
    expect(keyA).not.toBe(keyB)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Same projectPath → same partition (relaunch reuses storage)
// ─────────────────────────────────────────────────────────────────────────────
describe('project-path stability: same appId + same path', () => {
  it('returns the same partition across calls (storage survives a relaunch)', () => {
    const path = '/projects/myapp'
    const first = miniappPartition(APP_ID, path)
    const second = miniappPartition(APP_ID, path)

    // If the function is non-deterministic, the second open of the same project
    // would land on a different partition and orphan its storage — this test
    // catches that.
    expect(first).toBe(second)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Backward-compatibility: omitting projectPath keeps the old key shape
// ─────────────────────────────────────────────────────────────────────────────
describe('backward-compatibility: no projectPath', () => {
  it('miniappPartition(appId) without path equals miniappPartitionKey(appId)-based key', () => {
    const withoutPath = miniappPartition(APP_ID)
    const keyOnly = miniappPartitionKey(APP_ID)

    // Existing callers (pre-warm pool, legacy code) omit projectPath; they must
    // continue to get 'persist:miniapp-<appIdKey>' unchanged.
    expect(withoutPath).toBe(`persist:miniapp-${keyOnly}`)
  })

  it('partition WITH projectPath differs from partition WITHOUT projectPath (path is truly included)', () => {
    const withPath = miniappPartition(APP_ID, '/some/path')
    const withoutPath = miniappPartition(APP_ID)

    // If the implementation treats projectPath as a no-op, both values would be
    // equal — failing this assertion — and path-aware isolation would be broken.
    expect(withPath).not.toBe(withoutPath)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. A known project path isolates even when its manifest has no appId
// ─────────────────────────────────────────────────────────────────────────────
describe('project path is the fallback identity for an empty appId', () => {
  it('derives distinct stable filesystem-safe partitions and scopes for empty appIds', () => {
    const partA = miniappPartition('', '/a')
    const partB = miniappPartition('', '/b')

    expect(partA).toMatch(/^persist:miniapp-[A-Za-z0-9_-]+$/)
    expect(partB).toMatch(/^persist:miniapp-[A-Za-z0-9_-]+$/)
    expect(partA).not.toBe(partB)
    expect(miniappPartition('', '/a')).toBe(partA)
    expect(miniappFileScope(partA)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(miniappFileScope(partA)).not.toBe(miniappFileScope(partB))
  })

  it('uses the shared partition only when neither appId nor projectPath is known', () => {
    expect(miniappPartition('')).toBe(SHARED_MINIAPP_PARTITION)
    expect(miniappPartition(null)).toBe(SHARED_MINIAPP_PARTITION)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Filesystem safety: partition key contains only [A-Za-z0-9_-]
// ─────────────────────────────────────────────────────────────────────────────
describe('filesystem-safe partition key when projectPath contains special characters', () => {
	it('moves special-character appIds to stable SHA-256 partitions without collisions', () => {
		const first = miniappPartition('wxapp:team/a', '/project')
		const repeated = miniappPartition('wxapp:team/a', '/project')
		const distinct = miniappPartition('wxapp:team?a', '/project')
		expect(first).toBe(repeated)
		expect(first).not.toBe(distinct)
		expect(first).toMatch(/^persist:miniapp-wxappteama-[a-f0-9]{32}-p[a-f0-9]{32}$/)
	})

  it('key matches /^persist:miniapp-[A-Za-z0-9_-]+$/ even for paths with slashes and spaces', () => {
    // Electron uses the partition string as a on-disk folder name. If '/', ' ',
    // or other shell-special characters leak into the key, the session either
    // fails to open or silently maps to a different path — this assertion
    // ensures the hash folds all unsafe characters away.
    const nastyPath = '/My Projects/test app/path with spaces & symbols!'
    const partition = miniappPartition(APP_ID, nastyPath)

    expect(partition).toMatch(/^persist:miniapp-[A-Za-z0-9_-]+$/)
  })
})
