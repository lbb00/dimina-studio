import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from './fixtures'
import {
	closeProject,
	evalInSimulator,
	evalInWebContentsByUrl,
	getCurrentPage,
	ipcSend,
	openProject,
	pollUntil,
	RENDER_GUEST_URL_MARKER,
	waitForSimulatorWebview,
	waitSimulatorReady,
} from './helpers'
import { DEMO_APP_DIR } from './helpers'
import { settleBridgeCensus } from './resource-guards'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const PROJECT_A_DIR = path.resolve(__dirname, 'fixtures', 'fsm-app')
const PROJECT_B_DIR = path.resolve(__dirname, 'fixtures', 'fsm-isolation-reader')

const SERVICE_HOST_MARKER = '/service-host/service.html'

async function currentUrl(
	electronApp: import('@playwright/test').ElectronApplication,
	marker: string,
): Promise<string> {
	return electronApp.evaluate(({ webContents }, value) => {
		const wc = webContents.getAllWebContents().find(item => !item.isDestroyed() && item.getURL().includes(value))
		if (!wc) throw new Error(`missing webContents: ${value}`)
		return wc.getURL()
	}, marker)
}

async function assertFileNavigationBlocked(
	electronApp: import('@playwright/test').ElectronApplication,
	marker: string,
	filePath: string,
): Promise<void> {
	const before = await currentUrl(electronApp, marker)
	const markerText = `weak-isolation-${Date.now()}`
	await fs.writeFile(filePath, `<title>${markerText}</title><body>${markerText}</body>`)
	await expect(fs.stat(filePath)).resolves.toBeDefined()
	const target = pathToFileURL(filePath).toString()
	await evalInWebContentsByUrl(electronApp, marker, `location.href = ${JSON.stringify(target)}`)
	const after = await pollUntil(() => currentUrl(electronApp, marker), url => url === before, 5_000, 100)
	expect(after).toBe(before)
	const body = await evalInWebContentsByUrl<string>(electronApp, marker, 'document.body?.innerText || ""')
	expect(body).not.toContain(markerText)
}

async function assertNoWebContentsUsesUrl(
	electronApp: import('@playwright/test').ElectronApplication,
	target: string,
): Promise<void> {
	const urls = await electronApp.evaluate(({ webContents }) => webContents.getAllWebContents()
		.filter(item => !item.isDestroyed())
		.map(item => item.getURL()))
	expect(urls).not.toContain(target)
}

test.describe('weak isolation', () => {
	test.setTimeout(90_000)
	test.afterEach(async ({ electronApp }) => {
		await closeProject(electronApp).catch(() => {})
	})

	test('service and render realms have no Node or arbitrary IPC globals', async ({ electronApp }) => {
		await openProject(electronApp, DEMO_APP_DIR)
		await waitForSimulatorWebview(electronApp)
		await pollUntil(
			() => currentUrl(electronApp, RENDER_GUEST_URL_MARKER).catch(() => ''),
			url => url.length > 0,
			20_000,
			200,
		)
		for (const marker of [SERVICE_HOST_MARKER, RENDER_GUEST_URL_MARKER]) {
			const globals = await evalInWebContentsByUrl<Record<string, unknown>>(
				electronApp,
				marker,
				`(() => {
					const value = typeof process === 'undefined' ? undefined : process
					return { require: typeof require, process: typeof process, ipcRenderer: typeof ipcRenderer, nodeBindings: typeof __diminaNodeBindings, processKeys: value ? Object.keys(value).sort() : [], envKeys: value?.env ? Object.keys(value.env).sort() : [], frozen: value ? Object.isFrozen(value) : true }
				})()`,
			)
			expect(globals.require, `untrusted realm ${marker}`).toBe('undefined')
			expect(globals.ipcRenderer, `untrusted realm ${marker}`).toBe('undefined')
			expect(globals.nodeBindings, `untrusted realm ${marker}`).toBe('undefined')
			if (marker === RENDER_GUEST_URL_MARKER) {
				expect(globals).toMatchObject({ process: 'object', processKeys: ['env'], envKeys: ['NODE_ENV'], frozen: true })
			} else {
				expect(globals.process, `untrusted realm ${marker}`).toBe('undefined')
			}
		}
		const topBindings = await evalInSimulator<Record<string, unknown>>(
			electronApp,
			'({ exists: typeof __diminaNodeBindings, frozen: Object.isFrozen(__diminaNodeBindings), descriptor: Object.getOwnPropertyDescriptor(globalThis, "__diminaNodeBindings")?.writable })',
		)
		expect(topBindings).toMatchObject({ exists: 'object', frozen: true, descriptor: false })
	})

	test('service and render realms cannot navigate to an arbitrary file URL', async ({ electronApp }, testInfo) => {
		await openProject(electronApp, DEMO_APP_DIR)
		await waitForSimulatorWebview(electronApp)
		await pollUntil(() => currentUrl(electronApp, RENDER_GUEST_URL_MARKER).catch(() => ''), url => url.length > 0, 20_000, 200)
		const serviceFile = testInfo.outputPath('service-escape.html')
		const renderFile = testInfo.outputPath('render-escape.html')
		try {
			await assertFileNavigationBlocked(electronApp, SERVICE_HOST_MARKER, serviceFile)
			await assertFileNavigationBlocked(electronApp, RENDER_GUEST_URL_MARKER, renderFile)
		} finally {
			await Promise.all([fs.rm(serviceFile, { force: true }), fs.rm(renderFile, { force: true })])
		}
	})

	test('a render guest cannot load another dmb identity and owner loss releases its session', async ({ electronApp }) => {
		// Snapshot before opening so the assertion proves the owner-loss path
		// releases the whole app session rather than letting afterEach hide it.
		await closeProject(electronApp)
		const preOpen = await settleBridgeCensus(electronApp, () => true)
		await openProject(electronApp, DEMO_APP_DIR)
		await waitForSimulatorWebview(electronApp)
		await pollUntil(() => currentUrl(electronApp, RENDER_GUEST_URL_MARKER).catch(() => ''), url => url.length > 0, 20_000, 200)
		const target = 'dmb-resource://forged/__frame__.html?bridgeId=forged'
		const before = await currentUrl(electronApp, RENDER_GUEST_URL_MARKER)
		const beforeBody = await pollUntil(
			() => evalInWebContentsByUrl<string>(electronApp, RENDER_GUEST_URL_MARKER, 'document.body?.innerText || ""').catch(() => ''),
			body => body.length > 0,
			5_000,
			100,
		)
		await evalInWebContentsByUrl(electronApp, RENDER_GUEST_URL_MARKER, `location.href = ${JSON.stringify(target)}`)
		expect(await pollUntil(() => currentUrl(electronApp, RENDER_GUEST_URL_MARKER), url => url === before, 5_000, 100)).toBe(before)
		expect(await evalInWebContentsByUrl<string>(electronApp, RENDER_GUEST_URL_MARKER, 'document.body?.innerText || ""')).toBe(beforeBody)
		await assertNoWebContentsUsesUrl(electronApp, target)
		await evalInWebContentsByUrl(electronApp, RENDER_GUEST_URL_MARKER, `setTimeout(() => { location.href = ${JSON.stringify(target)} }, 0); location.href = 'about:blank'`)
		await assertNoWebContentsUsesUrl(electronApp, target)
		// Render navigation now rejects about:blank too. Exercise the owner-loss
		// path with Electron's actual WebContents destruction, which is the same
		// event emitted when a guest process exits unexpectedly.
		await electronApp.evaluate(({ webContents }, marker) => {
			const guest = webContents.getAllWebContents().find(item => !item.isDestroyed() && item.getURL().includes(marker))
			if (!guest) throw new Error(`missing render guest: ${marker}`)
			guest.close()
		}, RENDER_GUEST_URL_MARKER)
		const afterOwnerLoss = await settleBridgeCensus(
			electronApp,
			census => JSON.stringify(census) === JSON.stringify(preOpen),
		)
		expect(afterOwnerLoss).toEqual(preOpen)

		// The project remains selected after the guest self-terminates. Reopening
		// it must make a fresh session and page work without relying on afterEach.
		const reopened = await openProject(electronApp, DEMO_APP_DIR)
		await waitForSimulatorWebview(electronApp)
		await waitSimulatorReady(electronApp)
		const page = await pollUntil(
			() => getCurrentPage(electronApp, reopened.appId),
			value => value.path.length > 0,
			15_000,
			200,
		)
		expect(page.path).not.toBe('')
	})

	test('a forged bridge id from a non-simulator sender cannot dispose the live session', async ({ electronApp, mainWindow }) => {
		const opened = await openProject(electronApp, DEMO_APP_DIR)
		await waitForSimulatorWebview(electronApp)
		const bridgeId = await electronApp.evaluate((_electron, appId) => {
			const bridge = (globalThis as { __diminaBridgeHandle?: { getActiveBridgeId?: (id: string) => string } }).__diminaBridgeHandle
			return bridge?.getActiveBridgeId?.(appId)
		}, opened.appId)
		expect(bridgeId).toEqual(expect.any(String))
		await ipcSend(mainWindow, 'dmb:dispose', { bridgeId })
		const page = await pollUntil(
			() => getCurrentPage(electronApp, opened.appId),
			value => value.path.length > 0,
			15_000,
			200,
		)
		expect(page.path).not.toBe('')
	})

	test('real FSM disk files remain private to a project and survive reopening that project', async ({ electronApp }) => {
		await openProject(electronApp, PROJECT_A_DIR)
		await waitForSimulatorWebview(electronApp)
		const readResult = () => evalInWebContentsByUrl<string>(
			electronApp,
			RENDER_GUEST_URL_MARKER,
			'document.querySelector(".fsm-result")?.textContent || document.querySelector(".fsm-isolation-result")?.textContent || ""',
		)
		const aSummary = await pollUntil(readResult, text => text.includes('"readTargetOk":true'), 25_000, 200)
		expect(aSummary).toContain('"savedToTargetOk":true')
		await closeProject(electronApp)
		await openProject(electronApp, PROJECT_B_DIR)
		await waitForSimulatorWebview(electronApp)
		const bResult = await pollUntil(readResult, text => text === 'missing', 25_000, 200)
		expect(bResult).toBe('missing')
		await closeProject(electronApp)
		await openProject(electronApp, PROJECT_A_DIR)
		await waitForSimulatorWebview(electronApp)
		const aReopened = await pollUntil(readResult, text => text.includes('"readTargetOk":true'), 25_000, 200)
		expect(aReopened).toContain('"readTargetData":"save-me"')
	})
})
