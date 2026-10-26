/**
 * Make a fake device-shell webContents look like Electron's `<webview>` guest.
 *
 * Bridge IPC accepts a first SPAWN only when its sender belongs to the owning
 * workbench window. Tests call this explicitly for each legitimate device
 * shell; it intentionally does not make arbitrary fake WebContents trusted.
 */
export function attachBridgeTestGuest<T extends object>(
  guest: T,
  hostWebContents: object,
): T {
  Object.assign(guest, { hostWebContents })
  return guest
}
