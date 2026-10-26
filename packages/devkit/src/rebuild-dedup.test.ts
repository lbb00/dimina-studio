import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectRebuildController } from './rebuild-dispatch.js'

vi.mock('node:fs/promises', async (original) => {
  const module = await original<typeof import('node:fs/promises')>()
  return { ...module, readFile: vi.fn(module.readFile) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-dedup-')); roots.push(root)
  const file = path.join(root, 'app.js'); fs.writeFileSync(file, 'A')
  const build = vi.fn(async () => ({ appId: 'app', name: 'app', path: root }))
  const controller = createProjectRebuildController({
    compileWorker: { build } as never, buildRequest: { projectPath: root } as never, sessionApps: [], autoReload: false,
    getReload: () => undefined, getReloadStyles: () => undefined,
  })
  return { root, file, build, controller }
}

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return { promise, resolve }
}

describe('watch rebuild content revisions', () => {
  it('does not compile twice for two watcher events that observe identical file bytes', async () => {
    const { file, build, controller } = setup()
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    controller.notifyChanged(file)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(build).toHaveBeenCalledTimes(1)
  })

	it('still compiles an explicit rebuild with unchanged bytes', async () => {
    const { file, build, controller } = setup()
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    await controller.rebuild()
    expect(build).toHaveBeenCalledTimes(2)
	})

	it('keeps a trailing rebuild when bytes change from A to B during the first build', async () => {
		const { file, build, controller } = setup()
		const first = deferred<{ appId: string, name: string, path: string }>()
		build.mockImplementationOnce(() => first.promise)
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
		fs.writeFileSync(file, 'B')
		controller.notifyChanged(file)
		first.resolve({ appId: 'app', name: 'B', path: path.dirname(file) })
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
	})

  it('重新编译构建期间曾读取的中间版本，最终产物与恢复后的源码一致', async () => {
    const { root, file, build } = setup()
    const readNow = deferred(), captured = deferred(), finish = deferred()
    const apps: Array<{ appId: string; name: string; path: string }> = []
    build.mockImplementation(async () => ({ appId: 'app', name: fs.readFileSync(file, 'utf8'), path: root }))
    build.mockImplementationOnce(async () => {
      await readNow.promise
      const name = fs.readFileSync(file, 'utf8')
      captured.resolve()
      await finish.promise
      return { appId: 'app', name, path: root }
    })
    const controller = createProjectRebuildController({
      compileWorker: { build } as never, buildRequest: { projectPath: root } as never,
      sessionApps: apps, autoReload: false,
      getReload: () => undefined, getReloadStyles: () => undefined,
    })
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    fs.writeFileSync(file, 'B')
    controller.notifyChanged(file)
    readNow.resolve()
    await captured.promise
    fs.writeFileSync(file, 'A')
    controller.notifyChanged(file)
    finish.resolve()
    await vi.waitFor(() => expect(apps[0]?.name).toBe('A'))
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('读取版本期间发生的内容变化也必须触发最终源码的构建', async () => {
    const { root, file, build } = setup()
    const hashRead = deferred(), releaseHash = deferred(), workerRead = deferred(), finish = deferred()
    vi.mocked(readFile).mockImplementationOnce(async () => {
      const bytes = fs.readFileSync(file)
      hashRead.resolve()
      await releaseHash.promise
      return bytes
    })
    const apps: Array<{ appId: string; name: string; path: string }> = []
    build.mockImplementation(async () => ({ appId: 'app', name: fs.readFileSync(file, 'utf8'), path: root }))
    build.mockImplementationOnce(async () => {
      const name = fs.readFileSync(file, 'utf8')
      workerRead.resolve()
      await finish.promise
      return { appId: 'app', name, path: root }
    })
    const controller = createProjectRebuildController({
      compileWorker: { build } as never, buildRequest: { projectPath: root } as never,
      sessionApps: apps, autoReload: false, getReload: () => undefined, getReloadStyles: () => undefined,
    })
    controller.notifyChanged(file)
    await hashRead.promise
    fs.writeFileSync(file, 'B')
    controller.notifyChanged(file)
    releaseHash.resolve()
    await workerRead.promise
    fs.writeFileSync(file, 'A')
    controller.notifyChanged(file)
    finish.resolve()
    await vi.waitFor(() => expect(apps[0]?.name).toBe('A'))
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('失败通知回调抛错后恢复原内容仍重新编译', async () => {
    const { root, file, build } = setup()
    const onBuildError = vi.fn(() => { throw new Error('host callback failed') })
    const controller = createProjectRebuildController({
      compileWorker: { build } as never, buildRequest: { projectPath: root } as never,
      sessionApps: [], autoReload: false, getReload: () => undefined, getReloadStyles: () => undefined,
      onBuildError,
    })
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    fs.writeFileSync(file, 'B')
    build.mockRejectedValueOnce(new Error('compile failed'))
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(onBuildError).toHaveBeenCalledOnce())
    fs.writeFileSync(file, 'A')
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(3))
  })

  it('读取版本时收到相同字节通知仍只编译一次', async () => {
    const { root, file, build } = setup()
    const firstHash = deferred(), releaseHash = deferred(), trailingHash = deferred()
    vi.mocked(readFile).mockImplementationOnce(async () => {
      const bytes = fs.readFileSync(file)
      firstHash.resolve()
      await releaseHash.promise
      return bytes
    }).mockImplementationOnce(async () => {
      const bytes = fs.readFileSync(file)
      trailingHash.resolve()
      return bytes
    })
    const controller = createProjectRebuildController({
      compileWorker: { build } as never, buildRequest: { projectPath: root } as never,
      sessionApps: [], autoReload: false, getReload: () => undefined, getReloadStyles: () => undefined,
    })
    controller.notifyChanged(file)
    await firstHash.promise
    controller.notifyChanged(file)
    releaseHash.resolve()
    await trailingHash.promise
    await setImmediate()
    expect(build).toHaveBeenCalledOnce()
  })

  it('文件通知迟到时仍修正编译器读到的中间版本', async () => {
    const { root, file, build } = setup()
    const readNow = deferred(), captured = deferred(), finish = deferred(), published = deferred()
    const apps: Array<{ appId: string; name: string; path: string }> = []
    build.mockImplementation(async () => ({ appId: 'app', name: fs.readFileSync(file, 'utf8'), path: root }))
    build.mockImplementationOnce(async () => {
      await readNow.promise
      const name = fs.readFileSync(file, 'utf8')
      captured.resolve()
      await finish.promise
      return { appId: 'app', name, path: root }
    })
    const controller = createProjectRebuildController({
      compileWorker: { build } as never, buildRequest: { projectPath: root } as never,
      sessionApps: apps, autoReload: false, getReload: () => undefined, getReloadStyles: () => undefined,
      onRebuild: () => published.resolve(),
    })
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    fs.writeFileSync(file, 'B')
    readNow.resolve()
    await captured.promise
    fs.writeFileSync(file, 'A')
    finish.resolve()
    await published.promise
    await setImmediate()
    controller.notifyChanged(file)
    controller.notifyChanged(file)
    await vi.waitFor(() => expect(apps[0]?.name).toBe('A'))
    expect(build).toHaveBeenCalledTimes(2)
  })

	it('does not remember a failed build, so the same bytes retry', async () => {
		const { file, build, controller } = setup()
		build.mockRejectedValueOnce(new Error('compile failed'))
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
	})

	it('rebuilds when reverting a failed revision to the last successful contents', async () => {
		const { file, build, controller } = setup()
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
		fs.writeFileSync(file, 'B')
		build.mockRejectedValueOnce(new Error('invalid B'))
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
		fs.writeFileSync(file, 'A')
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(3))
	})

	it('uses a stable deletion revision to skip repeated unlink events', async () => {
		const { file, build, controller } = setup()
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
		fs.unlinkSync(file)
		controller.notifyChanged(file)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
		controller.notifyChanged(file)
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(build).toHaveBeenCalledTimes(2)
	})

	it('forces rebuilds when the changed path cannot be read as a file', async () => {
		const { root, build, controller } = setup()
		const directory = path.join(root, 'directory-change')
		fs.mkdirSync(directory)
		controller.notifyChanged(directory)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
		controller.notifyChanged(directory)
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
	})

	it('does not suppress reflection for the first style revision, but suppresses an identical repeat', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-style-')); roots.push(root)
		const style = path.join(root, 'app.wxss'); fs.writeFileSync(style, '.a{}')
		const build = vi.fn(async () => ({ appId: 'app', name: 'app', path: root }))
		const reloadStyles = vi.fn()
		const controller = createProjectRebuildController({ compileWorker: { build } as never, buildRequest: { projectPath: root } as never, sessionApps: [], autoReload: true, getReload: () => undefined, getReloadStyles: () => reloadStyles })
		controller.notifyChanged(style)
		await vi.waitFor(() => expect(reloadStyles).toHaveBeenCalledTimes(1))
		controller.notifyChanged(style)
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(build).toHaveBeenCalledTimes(1)
		expect(reloadStyles).toHaveBeenCalledTimes(1)
	})

	it('forces a build for watcher notifications without a path', async () => {
		const { build, controller } = setup()
		controller.notifyChanged()
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
		controller.notifyChanged()
		await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
	})
})
