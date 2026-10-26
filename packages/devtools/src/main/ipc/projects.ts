import { app, dialog } from 'electron'
import path from 'path'
import { ProjectsChannel, DialogChannel } from '../../shared/ipc-channels.js'
import {
  ProjectsAddSchema,
  ProjectsImportSchema,
  ProjectsOpenEditDialogSchema,
  ProjectsRemoveSchema,
  ProjectsUpdateSchema,
} from '../../shared/ipc-schemas.js'
import type { ProjectImportResult } from '../../shared/project-import-result.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { Disposable } from 'electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'
import { sanitizeTemplates } from '../services/projects/templates.js'
import { createProject } from '../services/projects/create-project-service.js'
import type { CreateProjectInput } from '../services/projects/types.js'
import {
  loadWorkbenchSettings,
  saveWorkbenchSettings,
} from '../services/settings/index.js'

export type ProjectsIpcCtx = Pick<
  WorkbenchContext,
  | 'workspace'
  | 'windows'
  | 'senderPolicy'
  | 'projectsProvider'
  | 'projectTemplates'
  | 'customCreateProjectDialog'
  | 'customEditProjectDialog'
  | 'notify'
  | 'views'
>

type ProjectRegistration = ProjectImportResult & { duplicate?: boolean }

async function registerProject(
  ctx: ProjectsIpcCtx,
  dirPath: string,
): Promise<ProjectRegistration> {
  const reason = await ctx.workspace.validateProjectDir(dirPath)
  if (reason) return { ok: false, reason }

  const duplicate = await ctx.workspace.hasProject(dirPath)
  const project = await ctx.workspace.addProject(dirPath)
  return { ok: true, project, duplicate }
}

function notifyImportedProject(ctx: ProjectsIpcCtx, project: { type?: 'miniprogram' | 'minigame' }) {
  const importedCategory = project.type ?? 'miniprogram'
  ctx.notify.hostSidebarCategorySelected(importedCategory)
  ctx.views.hostSidebar.send('project-category-forced', { category: importedCategory })
}

function invalidImportPathResult(): ProjectImportResult {
  return { ok: false, reason: '请输入完整的绝对项目目录路径。' }
}

export function registerProjectsIpc(input: IpcInput<ProjectsIpcCtx>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(ProjectsChannel.List, (ctx) => {
      return ctx.workspace.listProjects()
    })
    .handleRouted(DialogChannel.OpenDirectory, async (ctx) => {
      const result = await dialog.showOpenDialog(ctx.windows.mainWindow, {
        properties: ['openDirectory'],
        buttonLabel: '选择此目录',
        title: '选择小程序项目目录（选中目录后确认）',
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    })
    .handleRouted(ProjectsChannel.Add, async (ctx, _event, ...args: unknown[]) => {
      const [dirPath] = validate(ProjectsChannel.Add, ProjectsAddSchema, args)
      const result = await registerProject(ctx, dirPath)
      if (!result.ok) {
        await dialog.showMessageBox(ctx.windows.mainWindow, {
          type: 'error',
          title: '无法导入项目',
          message: '该目录不是有效的小程序项目',
          detail: result.reason,
          buttons: ['确定'],
        })
        throw new Error(result.reason)
      }
      if (result.duplicate) {
        await dialog.showMessageBox(ctx.windows.mainWindow, {
          type: 'info',
          title: '项目已存在',
          message: '该项目已在列表中',
          detail: dirPath,
          buttons: ['确定'],
        })
      }
      notifyImportedProject(ctx, result.project)
      return result.project
    })
    .handleRouted(ProjectsChannel.Import, async (ctx, _event, ...args: unknown[]) => {
      const parsed = ProjectsImportSchema.safeParse(args)
      if (!parsed.success) return invalidImportPathResult()
      try {
        const result = await registerProject(ctx, parsed.data[0])
        if (!result.ok) return result
        try {
          notifyImportedProject(ctx, result.project)
        } catch (error) {
          console.error('[projects] import notification failed', error)
        }
        return { ok: true, project: result.project }
      } catch (error) {
        console.error('[projects] import failed', error)
        return { ok: false, reason: '导入失败，请检查项目目录后重试。' }
      }
    })
    .handleRouted(ProjectsChannel.Remove, (ctx, _event, ...args: unknown[]) => {
      const [dirPath] = validate(ProjectsChannel.Remove, ProjectsRemoveSchema, args)
      return ctx.workspace.removeProject(dirPath)
    })
    .handleRouted(ProjectsChannel.Update, (ctx, _event, ...args: unknown[]) => {
      const [dirPath, patch] = validate(
        ProjectsChannel.Update,
        ProjectsUpdateSchema,
        args,
      )
      return ctx.workspace.updateProject(dirPath, patch)
    })
    // ── template catalog + create flow ──
    .handleRouted(ProjectsChannel.ListTemplates, (ctx) => {
      // Sanitize at the IPC boundary: `generate` is a function and the
      // structured-clone algorithm Electron uses for invoke would otherwise
      // throw "could not be cloned" before the renderer ever sees it.
      return sanitizeTemplates(ctx.projectTemplates ?? [])
    })
    .handleRouted(ProjectsChannel.OpenCreateDialog, async (ctx) => {
      if (!ctx.customCreateProjectDialog) return null
      const sanitized = sanitizeTemplates(ctx.projectTemplates ?? [])
      return await ctx.customCreateProjectDialog({
        parentWindow: ctx.windows.mainWindow,
        templates: sanitized,
      })
    })
    .handleRouted(ProjectsChannel.OpenEditDialog, async (ctx, _event, ...args: unknown[]) => {
      if (!ctx.customEditProjectDialog) return null
      const [dirPath] = validate(
        ProjectsChannel.OpenEditDialog,
        ProjectsOpenEditDialogSchema,
        args,
      )
      // Read from the workspace, not the renderer's args — the host sees
      // devtools' own authoritative record, never a client-supplied one.
      const project = (await ctx.workspace.listProjects()).find((p) => p.path === dirPath)
      if (!project) throw new Error(`No such project: ${dirPath}`)
      const result = await ctx.customEditProjectDialog({
        parentWindow: ctx.windows.mainWindow,
        project,
      })
      // Wrapped in `{ result }` so `null` on the wire means ONLY "no hook
      // configured" (renderer falls back to the built-in dialog). A hook that
      // ran and was cancelled resolves `result: null`, which the renderer
      // must treat as "do nothing" — otherwise a cancelled host dialog would
      // fall through into the built-in one right behind it.
      return { result }
    })
    .handleRouted(ProjectsChannel.Create, async (ctx, _event, ...args: unknown[]) => {
      // We deliberately don't run this through zod yet — the input shape is
      // wide (any template can stash arbitrary `extra` fields) and the
      // service does its own per-field validation. Bound size to keep this
      // a cheap DoS guard.
      const [raw] = args
      if (!raw || typeof raw !== 'object') {
        throw new Error('projects:create expects a CreateProjectInput object')
      }
      const input = raw as CreateProjectInput
      let project
      try {
        project = await createProject(input, {
          templates: ctx.projectTemplates ?? [],
          projectsProvider: ctx.projectsProvider,
        })
      } catch (err) {
        // Mirror the Add flow: surface scaffold failures (invalid name,
        // non-empty target dir, missing template, remote backend reject,
        // …) as a native dialog so users see *why* the create silently
        // fizzled. The renderer's catch then just bails out.
        await dialog.showMessageBox(ctx.windows.mainWindow, {
          type: 'error',
          title: '创建项目失败',
          message: '无法创建项目',
          detail: err instanceof Error ? err.message : String(err),
          buttons: ['确定'],
        })
        throw err
      }
      // Remember the parent of the just-created project so the next open of
      // the create dialog pre-fills its directory under the same workspace.
      try {
        const settings = loadWorkbenchSettings()
        const newBase = path.dirname(input.path)
        if (newBase && settings.lastCreateBaseDir !== newBase) {
          saveWorkbenchSettings({ ...settings, lastCreateBaseDir: newBase })
        }
      } catch (err) {
        console.warn('[projects:create] failed to persist lastCreateBaseDir', err)
      }
      return project
    })
    .handleRouted(ProjectsChannel.GetCreateDefaults, () => {
      // Fallback chain: persisted last parent → user's Documents → home.
      // Documents covers the common "我把项目都放在 Documents/ 下" case for
      // first-time users on macOS; home is just a safe final fallback.
      const settings = loadWorkbenchSettings()
      const baseDir =
        settings.lastCreateBaseDir ??
        safeAppPath('documents') ??
        safeAppPath('home') ??
        ''
      return { baseDir }
    })
}

function safeAppPath(name: 'documents' | 'home'): string | null {
  try {
    return app.getPath(name)
  } catch {
    return null
  }
}

export const projectsModule: WorkbenchModule = {
  setup: (ctx) => registerProjectsIpc(ctx),
}
