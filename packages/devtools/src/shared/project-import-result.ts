import type { EditableProject, ProjectType } from './types.js'

export interface ImportedProject extends EditableProject {
  type?: ProjectType
}

export type ProjectImportResult =
  | { ok: true; project: ImportedProject }
  | { ok: false; reason: string }
