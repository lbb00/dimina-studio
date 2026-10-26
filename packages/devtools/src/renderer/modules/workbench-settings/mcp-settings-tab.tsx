import type { ReactNode } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Switch } from '@/shared/components/ui/switch'
import { SettingsHelp } from '@/shared/components/settings-help'
import { SaveFeedbackButton } from '@/shared/components/save-feedback-button'
import type { McpStatus, WorkbenchSettingsValue } from '@/shared/api'

const MCP_SERVER_NAME = 'dimina'

export interface McpClientRegistration {
  url: string
  claudeCode: string
  codex: string
  mcpJson: string
}

export function buildMcpClientRegistration(port: number): McpClientRegistration {
  const url = `http://127.0.0.1:${port}/sse`
  return {
    url,
    claudeCode: `claude mcp add --transport sse ${MCP_SERVER_NAME} ${url}`,
    codex: `codex mcp add ${MCP_SERVER_NAME} --url ${url}`,
    mcpJson: `{
  "mcpServers": {
    "${MCP_SERVER_NAME}": {
      "url": "${url}"
    }
  }
}`,
  }
}

export function computeMcpNeedsRestart(
  mcpStatus: McpStatus | null,
  mcp: WorkbenchSettingsValue['mcp'],
): boolean {
  if (!mcpStatus) return false
  if (mcp.enabled !== mcpStatus.running) return true
  return mcp.enabled && mcpStatus.running && mcp.port !== mcpStatus.activePort
}

const STATUS_ROW_TONE_CLASS = {
  dim: 'bg-muted-foreground',
  success: 'bg-status-success',
  error: 'bg-status-error',
} as const

function StatusRow({ tone, children }: { tone: keyof typeof STATUS_ROW_TONE_CLASS; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-2 h-2 rounded-full ${STATUS_ROW_TONE_CLASS[tone]}`} />
      <span className="text-sm text-foreground">{children}</span>
    </div>
  )
}

function McpStatusPanel({
  mcpEnabled,
  mcpStatus,
}: {
  mcpEnabled: boolean
  mcpStatus: McpStatus | null
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted p-4">
      <div className="text-xs font-medium text-foreground">当前状态</div>
      {!mcpEnabled ? (
        <StatusRow tone="dim">MCP 未启用</StatusRow>
      ) : mcpStatus?.running ? (
        <StatusRow tone="success">
          MCP 已运行 - 端口 {mcpStatus.activePort}
        </StatusRow>
      ) : (
        <StatusRow tone="error">
          MCP 未运行
          {mcpStatus?.error === 'port-in-use'
            ? `（端口 ${mcpStatus.configuredPort} 已被占用）`
            : mcpStatus?.error
              ? `（${mcpStatus.error}）`
              : ''}
        </StatusRow>
      )}
    </div>
  )
}

export function McpTab({
  mcpEnabled,
  onToggleMcp,
  mcpPortInput,
  onMcpPortInputChange,
  mcpStatus,
  mcpPort,
  needsRestart,
  onSave,
  onRestart,
  saved,
}: {
  mcpEnabled: boolean
  onToggleMcp: () => void
  mcpPortInput: string
  onMcpPortInputChange: (value: string) => void
  mcpStatus: McpStatus | null
  mcpPort: number
  needsRestart: boolean
  onSave: () => void
  onRestart: () => void
  saved: boolean
}) {
  const registration = buildMcpClientRegistration(mcpPort)

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
      <div>
        <h2 className="text-[13px] font-medium">MCP 配置</h2>
      </div>

      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          启用 MCP 服务
          <SettingsHelp label="查看启用 MCP 服务说明">
            AI 助手可以通过 MCP 连接当前开发工具，读取 console、截图、执行 JS、查看 DOM / Storage / 网络请求。启用后开发工具启动时会自动监听 SSE 端点，并自动启用 CDP。
          </SettingsHelp>
        </span>
        <Switch checked={mcpEnabled} onCheckedChange={onToggleMcp} />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-1">
          <label className="text-sm text-muted-foreground">SSE 端口</label>
          <SettingsHelp label="查看 SSE 端口默认值说明">默认 7789</SettingsHelp>
        </div>
        <Input
          type="number"
          min={1024}
          max={65535}
          value={mcpPortInput}
          onChange={(e) => onMcpPortInputChange(e.target.value)}
          disabled={!mcpEnabled}
          className="w-24 h-7 px-2 text-[12px]"
        />
      </div>

      <McpStatusPanel mcpEnabled={mcpEnabled} mcpStatus={mcpStatus} />

      {needsRestart && (
        <div className="rounded px-3 py-2 text-[12px] border bg-warn-bg text-[var(--color-status-warn)] flex items-center justify-between gap-3">
          <span>配置已变更，需要重启应用后生效</span>
          <Button size="xs" onClick={onRestart} className="shrink-0">
            保存并重启
          </Button>
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted p-4">
        <div className="mb-2 text-xs font-medium text-foreground">本地客户端注册</div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-foreground">Claude Code</div>
            <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{registration.claudeCode}</pre>
          </div>
          <div>
            <div className="mb-1 text-xs text-foreground">Codex</div>
            <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{registration.codex}</pre>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted p-4">
        <div className="mb-2 text-xs font-medium text-foreground">`.mcp.json` 示例（SSE 传输）</div>
        <pre className="text-[11px] whitespace-pre-wrap leading-relaxed text-[var(--color-code-blue)] font-mono">{registration.mcpJson}</pre>
      </div>

      <SaveFeedbackButton onSave={onSave} saved={saved} />
    </section>
  )
}
