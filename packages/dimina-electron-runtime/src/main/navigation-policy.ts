import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pairs a webview's pre-creation policy with its eventual guest WebContents.
 * Electron exposes the source only in `will-attach-webview`; a cancelled
 * attach never emits `did-attach-webview`, so cancelled entries are removed
 * before the next attach can consume them.
 */
export class PendingWebviewAttachments<T> {
	#pending: Array<{ event: { defaultPrevented?: boolean }; value: T }> = []

	willAttach(event: { defaultPrevented?: boolean }, value: T): void {
		const entry = { event, value }
		this.#pending.push(entry)
		queueMicrotask(() => {
			if (!event.defaultPrevented) return
			const index = this.#pending.indexOf(entry)
			if (index >= 0) this.#pending.splice(index, 1)
		})
	}

	didAttach(): T | undefined {
		return this.#pending.shift()?.value
	}
}

export function allowSimulatorNavigation(target: string, simulatorUrl: string): boolean {
	try {
		const url = new URL(target)
		return url.href === 'about:blank' || url.origin === new URL(simulatorUrl).origin
	} catch {
		return false
	}
}

export function allowRenderNavigation(target: string, expectedFrameUrl: string): boolean {
	try {
		const url = new URL(target)
		const expected = new URL(expectedFrameUrl)
		return expected.protocol === 'dmb-resource:' && expected.hostname.length > 0
			&& expected.pathname.endsWith('/__frame__.html')
			&& url.protocol === expected.protocol && url.hostname === expected.hostname && url.pathname === expected.pathname && url.search === expected.search
	} catch {
		return false
	}
}

/** A service realm may only keep its configured runtime document. */
export function allowServiceHostNavigation(target: string, serviceHostHtmlPath: string): boolean {
	try {
		const url = new URL(target)
		if (url.href === 'about:blank') return true
		return url.protocol === 'file:'
			&& path.resolve(fileURLToPath(url)) === path.resolve(serviceHostHtmlPath)
	} catch {
		return false
	}
}
