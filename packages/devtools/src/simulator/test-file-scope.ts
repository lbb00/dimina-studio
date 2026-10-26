import path from 'node:path'
import { NODE_BINDINGS_GLOBAL } from '../shared/node-bindings.js'

export const TEST_FILE_SCOPE = 'simulator-api-test'

/** Publishes the same stable scope the simulator preload supplies in production. */
export function installTestFileScope(): void {
	Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, {
		value: Object.freeze({ fileScope: TEST_FILE_SCOPE }),
		writable: false,
		configurable: true,
		enumerable: true,
	})
}

export function clearTestFileScope(): void {
	Reflect.deleteProperty(globalThis, NODE_BINDINGS_GLOBAL)
}

export function scopedFilesBase(home: string): string {
	return path.join(home, 'files', TEST_FILE_SCOPE)
}
