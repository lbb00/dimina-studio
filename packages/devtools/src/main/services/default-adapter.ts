import type { CompilationAdapter } from '../../shared/types.js'
import type { OpenProjectOptions } from '@dimina-studio/devkit'
import path from 'path'
import { app } from 'electron'
import { simulatorDir } from '../utils/paths.js'

export const defaultAdapter: CompilationAdapter = {
  async openProject(opts) {
    const diminaStudio = await import('@dimina-studio/devkit')
    const openProjectOpts: OpenProjectOptions = {
      outputRoot: path.join(app.getPath('userData'), 'dimina-fe-output'),
      ...opts,
      simulatorDir,
    }
    return diminaStudio.openProject(openProjectOpts)
  },
}
