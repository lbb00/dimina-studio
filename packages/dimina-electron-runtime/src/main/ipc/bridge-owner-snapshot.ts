/** A live runtime WebContents and the session that currently owns it. */
export interface BridgeOwnerSnapshot {
  webContentsId: number
  sessionId: string
  role: 'render-page' | 'service-host'
}
