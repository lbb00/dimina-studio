import { app } from 'electron'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Rectangle } from 'electron'

interface GeometryRecord { key: string, bounds: Rectangle }
type OwnRead = { status: 'missing' | 'invalid' | 'unreadable', record?: undefined } | { status: 'valid', record: GeometryRecord }

function directory(): string { return path.join(app.getPath('userData'), 'window-geometry') }
function legacyFile(): string { return path.join(app.getPath('userData'), 'dimina-window-geometry.json') }
function fileFor(key: string): string { return path.join(directory(), `${createHash('sha256').update(key).digest('hex')}.json`) }

function isRectangle(value: unknown): value is Rectangle {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((name) => typeof bounds[name] === 'number' && Number.isFinite(bounds[name]) && (name === 'x' || name === 'y' || bounds[name] > 0))
}

function ownRecord(key: string): OwnRead {
  try {
    const record: unknown = JSON.parse(fs.readFileSync(fileFor(key), 'utf-8'))
    return record && typeof record === 'object' && (record as GeometryRecord).key === key && isRectangle((record as GeometryRecord).bounds) ? { status: 'valid', record: record as GeometryRecord } : { status: 'invalid' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    if (!(error instanceof SyntaxError)) console.warn('[window] failed to read geometry:', error)
    return error instanceof SyntaxError ? { status: 'invalid' } : { status: 'unreadable' }
  }
}

export function loadWindowGeometry(key: string | undefined): Rectangle | undefined {
  if (!key) return undefined
  const own = ownRecord(key)
  if (own.status === 'valid') return own.record.bounds
  if (own.status !== 'missing') return undefined
  try {
    const legacy: unknown = JSON.parse(fs.readFileSync(legacyFile(), 'utf-8'))
    const bounds = legacy && typeof legacy === 'object' ? (legacy as Record<string, unknown>)[key] : undefined
    return isRectangle(bounds) ? bounds : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) console.warn('[window] failed to read legacy geometry:', error)
    return undefined
  }
}

export function saveWindowGeometry(key: string | undefined, bounds: Rectangle): void {
  if (!key || !isRectangle(bounds)) return
  const file = fileFor(key)
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    if (ownRecord(key).status === 'unreadable') return
    fs.mkdirSync(directory(), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ key, bounds }), 'utf-8')
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch { /* disposable temp file */ }
    console.warn('[window] failed to save geometry:', error)
  }
}
