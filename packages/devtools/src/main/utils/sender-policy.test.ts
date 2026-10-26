import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createWindowContextRouter } from '../services/window-contexts/context-router.js'
import { createWorkbenchOwnedSenderCheck, createWorkbenchSenderPolicy } from './sender-policy.js'

const overlayGetters = [
  'getSettingsWebContentsId',
  'getPopoverWebContentsId',
  'getTooltipWebContentsId',
  'getProjectCreateDialogWebContentsId',
  'getUpdateDialogWebContentsId',
  'getDevicePickerWebContentsId',
  'getCompileStatusDetailsWebContentsId',
] as const

type OverlayGetter = (typeof overlayGetters)[number]
type PolicyContext = Parameters<typeof createWorkbenchSenderPolicy>[0]
type IdGetter = () => number | null

function sender(id: number, destroyed = false): WebContents {
  return { id, isDestroyed: vi.fn(() => destroyed) } as unknown as WebContents
}

function createContext() {
  const overlayIds: Record<OverlayGetter, number | null> = {
    getSettingsWebContentsId: null,
    getPopoverWebContentsId: null,
    getTooltipWebContentsId: null,
    getProjectCreateDialogWebContentsId: null,
    getUpdateDialogWebContentsId: null,
    getDevicePickerWebContentsId: null,
    getCompileStatusDetailsWebContentsId: null,
  }
  const getters = Object.fromEntries(overlayGetters.map((name) => [name, vi.fn<IdGetter>(() => overlayIds[name])])) as Record<OverlayGetter, ReturnType<typeof vi.fn<IdGetter>>>
  const windows = {
    isMainSender: vi.fn<(id: number) => boolean>(() => false),
    isSettingsWindowSender: vi.fn<(id: number) => boolean>(() => false),
  }
  const trustedWindowSenderIds = new Map<number, number>()
  const views = {
    ...getters,
    getHostToolbarWebContentsId: vi.fn<IdGetter>(() => 71),
    getSimulatorWebContentsId: vi.fn<IdGetter>(() => 72),
    getHostSidebarWebContentsId: vi.fn<IdGetter>(() => 73),
    getHostDialogWebContentsId: vi.fn<IdGetter>(() => 74),
  }
  const ctx = { windows, views, trustedWindowSenderIds } as unknown as PolicyContext
  return { ctx, overlayIds, getters, windows, trustedWindowSenderIds }
}

describe('workbench sender policy', () => {
  it.each(overlayGetters)('允许并归属受信任覆盖层 %s', (getter) => {
    const h = createContext()
    h.overlayIds[getter] = 40

    expect(createWorkbenchSenderPolicy(h.ctx)(sender(40))).toBe(true)
    expect(createWorkbenchOwnedSenderCheck(h.ctx)(sender(40))).toBe(true)
  })

  it('主窗口和独立设置窗口通过时不读取覆盖层', () => {
    const h = createContext()
    h.windows.isMainSender.mockImplementation((id) => id === 1)
    h.windows.isSettingsWindowSender.mockImplementation((id) => id === 2)
    const owns = createWorkbenchOwnedSenderCheck(h.ctx)

    expect(owns(sender(1))).toBe(true)
    expect(owns(sender(2))).toBe(true)
    for (const getter of overlayGetters) expect(h.getters[getter]).not.toHaveBeenCalled()
  })

  it('已销毁 sender 即使在共享信任集合中也被拒绝', () => {
    const h = createContext()
    h.trustedWindowSenderIds.set(9, 1)

    expect(createWorkbenchSenderPolicy(h.ctx)(sender(9, true))).toBe(false)
    expect(createWorkbenchOwnedSenderCheck(h.ctx)(sender(9, true))).toBe(false)
    for (const getter of overlayGetters) expect(h.getters[getter]).not.toHaveBeenCalled()
  })

  it('不把宿主工具栏、模拟器或宿主侧栏和对话框加入白名单', () => {
    const h = createContext()
    const policy = createWorkbenchSenderPolicy(h.ctx)

    expect(policy(sender(71))).toBe(false)
    expect(policy(sender(72))).toBe(false)
    expect(policy(sender(73))).toBe(false)
    expect(policy(sender(74))).toBe(false)
    expect(policy(sender(75))).toBe(false)
  })

  it('共享信任窗口仅由 policy 接受，不属于任一 context', () => {
    const h = createContext()
    h.trustedWindowSenderIds.set(50, 1)
    const shared = sender(50)

    expect(createWorkbenchSenderPolicy(h.ctx)(shared)).toBe(true)
    expect(createWorkbenchOwnedSenderCheck(h.ctx)(shared)).toBe(false)
  })

  it('每次查询覆盖层当前 id，旧 id 不会因视图重建保留信任', () => {
    const h = createContext()
    h.overlayIds.getTooltipWebContentsId = 10
    const owns = createWorkbenchOwnedSenderCheck(h.ctx)

    expect(owns(sender(10))).toBe(true)
    h.overlayIds.getTooltipWebContentsId = 11
    expect(owns(sender(10))).toBe(false)
    expect(owns(sender(11))).toBe(true)
  })

  it('getter 保留 views receiver，较早匹配时不读取后续覆盖层', () => {
    const h = createContext()
    const views = {
      ...h.getters,
      overlayId: 66,
      getSettingsWebContentsId() { return this.overlayId },
    }
    const ctx = { ...h.ctx, views } as unknown as PolicyContext
    const owns = createWorkbenchOwnedSenderCheck(ctx)

    expect(owns(sender(66))).toBe(true)
    for (const getter of overlayGetters.slice(1)) expect(h.getters[getter]).not.toHaveBeenCalled()
  })

  it('路由将 B 的自有 sender 交给 B，但共享 host sender 仍交给活动 A', () => {
    const a = createContext()
    const b = createContext()
    a.windows.isMainSender.mockImplementation((id) => id === 1)
    b.windows.isMainSender.mockImplementation((id) => id === 2)
    const sharedHost = sender(90)
    a.trustedWindowSenderIds.set(sharedHost.id, 1)
    b.trustedWindowSenderIds.set(sharedHost.id, 1)
    const contextA = {
      senderPolicy: createWorkbenchSenderPolicy(a.ctx),
      ownsSender: createWorkbenchOwnedSenderCheck(a.ctx),
    }
    const contextB = {
      senderPolicy: createWorkbenchSenderPolicy(b.ctx),
      ownsSender: createWorkbenchOwnedSenderCheck(b.ctx),
    }
    const router = createWindowContextRouter()
    router.register(contextA)
    router.register(contextB)
    router.setActive(contextA)

    expect(router.resolve(sender(2))).toBe(contextB)
    expect(router.active()).toBe(contextA)
    expect(router.resolve(sharedHost)).toBe(contextA)
  })
})
