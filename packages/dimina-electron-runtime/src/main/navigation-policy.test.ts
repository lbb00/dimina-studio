import { describe, expect, it } from 'vitest'
import {
	allowRenderNavigation,
	allowServiceHostNavigation,
	allowSimulatorNavigation,
	PendingWebviewAttachments,
} from './navigation-policy.js'

describe('untrusted realm navigation policy', () => {
	it('rejects external file navigation while retaining each realm’s required internal URL', () => {
		expect(allowSimulatorNavigation('http://127.0.0.1:3000/next', 'http://127.0.0.1:3000/simulator.html')).toBe(true)
		expect(allowSimulatorNavigation('http://127.0.0.1:3001/escape', 'http://127.0.0.1:3000/simulator.html')).toBe(false)
		expect(allowSimulatorNavigation('file:///tmp/escape.html', 'http://127.0.0.1:3000/simulator.html')).toBe(false)
		expect(allowRenderNavigation('dmb-resource://app/__frame__.html?bridgeId=a', 'dmb-resource://app/__frame__.html?bridgeId=a')).toBe(true)
		expect(allowRenderNavigation('dmb-resource://app/__frame__.html?bridgeId=b', 'dmb-resource://app/__frame__.html?bridgeId=a')).toBe(false)
		expect(allowRenderNavigation('dmb-resource://app/attacker.html?bridgeId=a', 'dmb-resource://app/__frame__.html?bridgeId=a')).toBe(false)
		expect(allowRenderNavigation('about:srcdoc', 'dmb-resource://app/__frame__.html?bridgeId=a')).toBe(false)
		expect(allowRenderNavigation('file:///tmp/escape.html', 'dmb-resource://app/__frame__.html?bridgeId=a')).toBe(false)
		expect(allowServiceHostNavigation('file:///runtime/service-host/service.html?bridgeId=a', '/runtime/service-host/service.html')).toBe(true)
		expect(allowServiceHostNavigation('file:///tmp/escape.html', '/runtime/service-host/service.html')).toBe(false)
	})
})

describe('pending webview attachment binding', () => {
	it('preserves per-attach expected frames, including a missing src fail-closed entry', async () => {
		const pending = new PendingWebviewAttachments<string | null>()
		pending.willAttach({}, 'dmb-resource://a/__frame__.html?bridgeId=a')
		pending.willAttach({}, null)
		pending.willAttach({}, 'dmb-resource://b/__frame__.html?bridgeId=b')
		expect(pending.didAttach()).toBe('dmb-resource://a/__frame__.html?bridgeId=a')
		expect(pending.didAttach()).toBeNull()
		expect(pending.didAttach()).toBe('dmb-resource://b/__frame__.html?bridgeId=b')
	})

	it('removes a cancelled attach before the next guest is bound', async () => {
		const pending = new PendingWebviewAttachments<string>()
		const cancelled = { defaultPrevented: false }
		pending.willAttach(cancelled, 'dmb-resource://a/__frame__.html?bridgeId=a')
		cancelled.defaultPrevented = true
		await Promise.resolve()
		pending.willAttach({}, 'dmb-resource://b/__frame__.html?bridgeId=b')
		expect(pending.didAttach()).toBe('dmb-resource://b/__frame__.html?bridgeId=b')
	})
})
