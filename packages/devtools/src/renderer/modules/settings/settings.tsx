import React, { useState, useEffect } from 'react'
import { Switch } from '@/shared/components/ui/switch'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet'
import { SettingsTabBar } from '@/shared/components/settings-tab-bar'
import { SettingsHelp } from '@/shared/components/settings-help'
import {
  emitProjectSettingsChanged,
  onSettingsInit,
  notifyOverlayReady,
  setSettingsVisible,
} from '@/shared/api'

const TABS = [
  { id: 'local', label: '本地设置' },
  { id: 'project', label: '项目配置' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function Settings() {
  const [activeTab, setActiveTab] = useState<TabId>('local')
  const [projectPath, setProjectPath] = useState('')
  const [projectSettings, setProjectSettings] = useState({
    uploadWithSourceMap: false,
  })

  useEffect(() => {
    const off = onSettingsInit((data) => {
      setProjectPath(data.projectPath)
      setProjectSettings({
        uploadWithSourceMap: !!data.projectSettings?.uploadWithSourceMap,
      })
    })
    notifyOverlayReady()
    return off
  }, [])

  function updateProjectSettings(patch: Partial<typeof projectSettings>) {
    const next = { ...projectSettings, ...patch }
    setProjectSettings(next)
    emitProjectSettingsChanged(next)
  }

  function renderCheckItem(
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void
  ) {
    return (
      <label className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border bg-background cursor-pointer">
        <span className="text-sm text-foreground">{label}</span>
        <Switch checked={checked} onCheckedChange={onChange} />
      </label>
    )
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) void setSettingsVisible(false) }}>
      <SheetContent
        side="right"
        data-testid="settings-panel"
        className="w-[320px] max-w-[90vw] p-0"
        overlayProps={{
          'data-testid': 'settings-backdrop',
          onClick: () => void setSettingsVisible(false),
        }}
      >
        <SheetHeader className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-1">
            <SheetTitle>设置</SheetTitle>
            <SettingsHelp label="查看设置说明">管理开发工具和当前项目的配置。</SettingsHelp>
          </div>
          <SheetDescription className="sr-only">管理开发工具和当前项目的配置。</SheetDescription>
        </SheetHeader>
      <SettingsTabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'local' && (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">本地设置</div>
            {renderCheckItem(
              '上传时启用 Sourcemap',
              projectSettings.uploadWithSourceMap,
              (checked) => updateProjectSettings({ uploadWithSourceMap: checked })
            )}
          </div>
        )}
        {activeTab === 'project' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">本地目录</span>
              <span
                className="ml-4 max-w-[180px] truncate text-sm text-foreground"
                title={projectPath}
              >
                {projectPath}
              </span>
            </div>

            {/* 启动页面 / scene are NOT edited here: the compile-mode dropdown
                owns them, and a second editor of the same state would silently
                write a configuration no mode in the list describes. */}
          </div>
        )}
      </div>
      </SheetContent>
    </Sheet>
  )
}
