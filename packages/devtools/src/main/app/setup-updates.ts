import type { WorkbenchAppConfig } from '../../shared/types.js'
import { UpdateManager } from '../services/update/index.js'
import type { ProjectListSurface } from './project-list-surface.js'
import type { SenderPolicy } from '../utils/ipc-registry.js'
import type { ViewManager } from '../services/views/view-manager.js'
import type { DisposableRegistry } from 'electron-deck/main'

export function setupUpdates(
  config: WorkbenchAppConfig,
  projectList: ProjectListSurface,
  context: {
    senderPolicy: SenderPolicy
    views: Pick<ViewManager, 'notifyUpdateDownloadProgress' | 'hideUpdateDialog'>
  },
  registry: DisposableRegistry,
): UpdateManager | undefined {
  if (!config.updateChecker) return undefined

  const updateManager = new UpdateManager({
    checker: config.updateChecker,
    showUpdatePanel: (info) => projectList.showUpdate(info),
    notifyDownloadProgress: (percent) => context.views.notifyUpdateDownloadProgress(percent),
    hideUpdatePanel: () => context.views.hideUpdateDialog(),
    senderPolicy: context.senderPolicy,
    checkInterval: config.updateOptions?.checkInterval,
    initialDelay: config.updateOptions?.initialDelay,
    getCurrentVersion: config.updateOptions?.getCurrentVersion,
  })
  registry.add(() => updateManager.dispose())
  return updateManager
}
