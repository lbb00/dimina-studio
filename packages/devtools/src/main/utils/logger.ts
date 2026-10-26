/**
 * Tagged console logger. The implementation lives in
 * `electron-deck/main` (single source — the two packages share one
 * logger); this module re-exports it so devtools-internal imports keep their
 * stable `utils/logger` path.
 */
export { createLogger, setLogLevel, type Logger } from 'electron-deck/main'
