/**
 * WeChat FileSystemManager.readFile range on the container Node fs backend.
 *
 * position is the start byte and defaults to 0. length is how many bytes to
 * return; omitting it reads through EOF. A position or length that is not a
 * non-negative safe integer fails. Values are not clamped. A start past EOF
 * is an empty read, and a length past EOF stops at the last byte. Encoding
 * is applied to the sliced bytes.
 */

import type { MiniAppContext } from './types'
import type { bindCallbacks } from './simulator-api-helpers'

type FsCallbacks = ReturnType<typeof bindCallbacks>

export type FileReadOptions = {
	filePath: string
	encoding?: BufferEncoding
	position?: unknown
	length?: unknown
	success?: unknown
	fail?: unknown
	complete?: unknown
}

interface ReadRange {
	start: number
	end: number | undefined
}

interface ReadFileDeps {
	bindCallbacks: (ctx: MiniAppContext, opts: { success?: unknown; fail?: unknown; complete?: unknown }) => FsCallbacks
	guardFsAvailable: (apiName: string, cbs: FsCallbacks) => boolean
	resolveOrBail: (p: unknown, apiName: string, cbs: FsCallbacks) => { kind: string; realPath?: string } | undefined
	tmpBytes: (url: string) => Promise<Buffer>
	tmpFailHandler: (apiName: string, cbs: FsCallbacks) => (err: Error) => void
	readFile: (path: string, cb: (err: NodeJS.ErrnoException | null, data: Buffer) => void) => void
}

const API = 'fsReadFile'

function failRead(cbs: FsCallbacks, err: Error): void {
	cbs.onFail?.({ errMsg: `${API}:fail ${err.message}` })
	cbs.onComplete?.()
}

function succeedRead(cbs: FsCallbacks, data: Buffer | string): void {
	cbs.onSuccess?.({ data, errMsg: `${API}:ok` })
	cbs.onComplete?.()
}

/** Rejects ranges that are not non-negative safe integers. Undefined length means EOF. */
export function parseFileRange(position: unknown, length: unknown): ReadRange {
	const start = position === undefined ? 0 : position
	if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) {
		throw new RangeError('invalid file range')
	}
	if (length === undefined) return { start, end: undefined }
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
		throw new RangeError('invalid file range')
	}
	return { start, end: start + length }
}

/** Slices [start, end) and, when encoding is set, decodes only that slice. */
export function sliceFileBytes(buf: Buffer, range: ReadRange, encoding?: BufferEncoding): Buffer | string {
	const sliced = range.end === undefined ? buf.subarray(range.start) : buf.subarray(range.start, range.end)
	return encoding ? sliced.toString(encoding) : sliced
}

export function readFileWithRange(ctx: MiniAppContext, opts: FileReadOptions, deps: ReadFileDeps): void {
	const cbs = deps.bindCallbacks(ctx, opts)
	if (deps.guardFsAvailable(API, cbs)) return
	let range: ReadRange
	try {
		range = parseFileRange(opts.position, opts.length)
	} catch (err) {
		failRead(cbs, err instanceof Error ? err : new Error(String(err)))
		return
	}
	const resolved = deps.resolveOrBail(opts.filePath, API, cbs)
	if (!resolved) return
	const deliver = (buf: Buffer) => {
		try {
			succeedRead(cbs, sliceFileBytes(buf, range, opts.encoding))
		} catch (err) {
			failRead(cbs, err instanceof Error ? err : new Error(String(err)))
		}
	}
	if (resolved.kind === 'tmp') {
		const onTmpFail = deps.tmpFailHandler(API, cbs)
		deps.tmpBytes(opts.filePath).then(deliver, (err: unknown) => {
			onTmpFail(err instanceof Error ? err : new Error(String(err)))
		})
		return
	}
	if (!resolved.realPath) {
		failRead(cbs, new Error('invalid path'))
		return
	}
	deps.readFile(resolved.realPath, (err, data) => {
		if (err) failRead(cbs, err)
		else deliver(data)
	})
}
