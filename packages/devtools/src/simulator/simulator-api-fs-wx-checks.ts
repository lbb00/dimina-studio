/**
 * wx FileSystemManager preconditions that Node's own fs primitives don't
 * enforce on their own. Kept out of simulator-api-fs.ts (call sites there
 * stay one-liners) so that file's size doesn't grow while still covering
 * the gap between Node and wx semantics:
 *
 *   - `fs.mkdir(p, {recursive:true})` does not error when `p` already
 *     exists; wx always fails an existing target, recursive or not.
 *   - `fs.appendFile` creates a missing target; wx requires the target to
 *     already exist and fails on a missing or directory target.
 *   - `fs.copyFile(p, p)` truncates the file through an overlapping
 *     read/write instead of the no-op wx defines for src === dest.
 */

type FsMod = typeof import('fs')
type NodeErr = NodeJS.ErrnoException | Error | null

/** wx mkdir: an existing target always fails, independent of `recursive`. */
export function mkdirWx(fsMod: FsMod, realPath: string, recursive: boolean, done: (err: NodeErr) => void): void {
	fsMod.lstat(realPath, (existsErr) => {
		if (!existsErr) {
			done(new Error(`file already exists ${realPath}`))
			return
		}
		fsMod.mkdir(realPath, { recursive }, done)
	})
}

/** wx appendFile: the target must already exist as a regular file. */
export function appendFileWx(
	fsMod: FsMod,
	realPath: string,
	data: string | Uint8Array,
	opts: { encoding: BufferEncoding },
	done: (err: NodeErr) => void,
): void {
	fsMod.stat(realPath, (statErr, st) => {
		if (statErr) {
			done(statErr)
			return
		}
		if (st.isDirectory()) {
			done(new Error(`illegal operation on a directory, open "${realPath}"`))
			return
		}
		fsMod.appendFile(realPath, data as string, opts, done)
	})
}

/** wx copyFile: src === dest (same real path) is a defined no-op, not Node's overlapping-fd truncation. */
export function copyFileWx(fsMod: FsMod, srcReal: string, destReal: string, done: (err: NodeErr) => void): void {
	if (srcReal !== destReal) {
		fsMod.copyFile(srcReal, destReal, done)
		return
	}
	fsMod.stat(srcReal, (statErr, st) => {
		if (statErr) {
			done(statErr)
			return
		}
		done(st.isFile() ? null : new Error(`illegal operation on a directory, copyfile '${srcReal}'`))
	})
}
