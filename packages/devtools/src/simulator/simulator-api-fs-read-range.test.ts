/**
 * FileSystemManager.readFile range on the container Node fs backend.
 *
 * position is the start byte (default 0). length is how many bytes to read;
 * omitting it reads through EOF. The slice is applied before the
 * `__diminaArrayBufferBase64` sentinel is built, and a string encoding
 * decodes only those bytes. A position or length that is not a non-negative
 * safe integer fails the read. A start past EOF is an empty success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import type { MiniAppContext } from './types'
import { simulatorApis } from './simulator-api'
import { clearTestFileScope, installTestFileScope, scopedFilesBase } from './test-file-scope'

const ARRAY_BUFFER_BASE64_KEY = '__diminaArrayBufferBase64'
const FILE_PATH = 'difile://usr/read-range.bin'

interface InvokeResult { success?: unknown; fail?: unknown; complete: boolean }

function invoke(args: Record<string, unknown>): Promise<InvokeResult> {
	const handler = (simulatorApis as Record<string, unknown>)['FileSystemManager.readFile']
	if (typeof handler !== 'function') {
		throw new Error('FileSystemManager.readFile is not registered')
	}
	return new Promise((resolve) => {
		let resolved = false
		let successResult: unknown
		let failResult: unknown
		let didComplete = false
		const settle = () => {
			if (resolved) return
			resolved = true
			resolve({ success: successResult, fail: failResult, complete: didComplete })
		}
		const success = vi.fn((r: unknown) => { successResult = r })
		const fail = vi.fn((r: unknown) => { failResult = r })
		const complete = vi.fn(() => { didComplete = true; settle() })
		setTimeout(settle, 500)
		const ctx = {
			appId: 'test-app',
			createCallbackFunction: (fn: unknown) =>
				typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined,
		} as unknown as MiniAppContext
		;(handler as (this: MiniAppContext, opts: Record<string, unknown>) => void)
			.call(ctx, { filePath: FILE_PATH, ...args, success, fail, complete })
	})
}

function errMsg(payload: unknown): string {
	if (payload && typeof payload === 'object' && 'errMsg' in payload) {
		return String((payload as { errMsg: unknown }).errMsg)
	}
	return ''
}

function dataOf(result: InvokeResult): unknown {
	return (result.success as { data?: unknown } | undefined)?.data
}

let sandboxHome: string

function usrDir(): string {
	return nodePath.join(scopedFilesBase(sandboxHome), 'usr')
}

beforeEach(() => {
	installTestFileScope()
	sandboxHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dimina-read-range-'))
	process.env.DIMINA_HOME = sandboxHome
	nodeFs.mkdirSync(usrDir(), { recursive: true })
	nodeFs.writeFileSync(nodePath.join(usrDir(), 'read-range.bin'), Buffer.from([0, 1, 2, 3, 4, 5]))
})

afterEach(() => {
	clearTestFileScope()
	delete process.env.DIMINA_HOME
	if (sandboxHome && nodeFs.existsSync(sandboxHome)) {
		nodeFs.rmSync(sandboxHome, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
})

describe('readFile position and length slice bytes before the transport sentinel', () => {
	it('a middle slice base64-encodes only the requested bytes', async () => {
		const result = await invoke({ position: 2, length: 2 })
		expect(result.fail, JSON.stringify(result.fail)).toBeUndefined()
		expect(dataOf(result)).toEqual({
			[ARRAY_BUFFER_BASE64_KEY]: Buffer.from([2, 3]).toString('base64'),
		})
	})

	it('position 0 with length reads that prefix', async () => {
		const explicit = await invoke({ position: 0, length: 2 })
		expect(explicit.fail, JSON.stringify(explicit.fail)).toBeUndefined()
		expect(dataOf(explicit)).toEqual({
			[ARRAY_BUFFER_BASE64_KEY]: Buffer.from([0, 1]).toString('base64'),
		})

		const omittedPosition = await invoke({ length: 2 })
		expect(omittedPosition.fail, JSON.stringify(omittedPosition.fail)).toBeUndefined()
		expect(dataOf(omittedPosition)).toEqual({
			[ARRAY_BUFFER_BASE64_KEY]: Buffer.from([0, 1]).toString('base64'),
		})
	})

	it('length that extends past EOF reads only the available tail', async () => {
		const result = await invoke({ position: 4, length: 10 })
		expect(result.fail, JSON.stringify(result.fail)).toBeUndefined()
		expect(dataOf(result)).toEqual({
			[ARRAY_BUFFER_BASE64_KEY]: Buffer.from([4, 5]).toString('base64'),
		})
	})

	it('omitted length reads from position through EOF', async () => {
		const result = await invoke({ position: 4 })
		expect(result.fail, JSON.stringify(result.fail)).toBeUndefined()
		expect(dataOf(result)).toEqual({
			[ARRAY_BUFFER_BASE64_KEY]: Buffer.from([4, 5]).toString('base64'),
		})
	})

	it('a string encoding decodes the sliced bytes', async () => {
		nodeFs.writeFileSync(nodePath.join(usrDir(), 'read-range.bin'), Buffer.from('abcdef'))
		const result = await invoke({ position: 2, length: 3, encoding: 'utf8' })
		expect(result.fail, JSON.stringify(result.fail)).toBeUndefined()
		expect(dataOf(result)).toBe('cde')
	})

	it('position past EOF reads empty bytes', async () => {
		const result = await invoke({ position: 100, length: 4 })
		expect(result.fail, JSON.stringify(result.fail)).toBeUndefined()
		expect(dataOf(result)).toEqual({
			[ARRAY_BUFFER_BASE64_KEY]: Buffer.alloc(0).toString('base64'),
		})
	})

	it('a position that is not a non-negative safe integer fails the read', async () => {
		const negative = await invoke({ position: -1, length: 2 })
		expect(negative.success).toBeUndefined()
		expect(errMsg(negative.fail)).toMatch(/^readFile:fail /)

		const fraction = await invoke({ position: 1.5 })
		expect(fraction.success).toBeUndefined()
		expect(errMsg(fraction.fail)).toMatch(/^readFile:fail /)

		const badLength = await invoke({ position: 0, length: -1 })
		expect(badLength.success).toBeUndefined()
		expect(errMsg(badLength.fail)).toMatch(/^readFile:fail /)
	})
})
