export interface AppInfo {
	appId: string
	name: string
	path: string
}

export type CompileDiagnostic = {
	source: string
	line: number
	column: number
	endLine: number
	endColumn: number
	message: string
	severity: 'warning' | 'error'
}

export interface BuildResult extends AppInfo {
	diagnostics?: CompileDiagnostic[]
}

export interface ProjectSession {
	appInfo: AppInfo
	diagnostics?: CompileDiagnostic[]
	port: number
	rebuild: () => Promise<void>
	close: () => Promise<void>
}
