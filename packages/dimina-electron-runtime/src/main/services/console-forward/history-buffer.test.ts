import { describe, expect, it } from 'vitest'
import { createConsoleForwarder, type GuestConsoleEntry } from './index.js'

/**
 * Pins the replay history buffer's contract (see the `subscribe` doc comment
 * in index.ts): bounded capacity, oldest-dropped-first, and replay delivers
 * surviving entries oldest→newest. No service host is wired up (both bridge
 * lookups return null) so `emit` only exercises the buffer/sink path, not the
 * render→service forward.
 */
function makeForwarder() {
  return createConsoleForwarder({
    getServiceWc: () => null,
    getServiceWcForBridge: () => null,
  })
}

// Mirrors the module-private CONSOLE_BUFFER_CAP; kept as a literal here since
// the cap isn't part of the public export surface.
const BUFFER_CAP = 200

function entry(ts: number): GuestConsoleEntry {
  return { source: 'service', level: 'log', args: [ts], ts }
}

describe('console forwarder replay history buffer', () => {
  it('replays entries oldest to newest when under capacity', () => {
    const forwarder = makeForwarder()
    for (let i = 0; i < 5; i++) forwarder.emit(entry(i))

    const replayed: GuestConsoleEntry[] = []
    forwarder.subscribe(e => replayed.push(e), { replay: true })

    expect(replayed.map(e => e.ts)).toEqual([0, 1, 2, 3, 4])
  })

  it('drops the oldest entries once capacity is exceeded, keeping the newest N', () => {
    const forwarder = makeForwarder()
    const total = BUFFER_CAP + 50
    for (let i = 0; i < total; i++) forwarder.emit(entry(i))

    const replayed: GuestConsoleEntry[] = []
    forwarder.subscribe(e => replayed.push(e), { replay: true })

    expect(replayed).toHaveLength(BUFFER_CAP)
    // Oldest surviving entry is the (total - BUFFER_CAP)th push; newest is the last.
    expect(replayed[0].ts).toBe(total - BUFFER_CAP)
    expect(replayed[replayed.length - 1].ts).toBe(total - 1)
    // Still strictly increasing / contiguous — nothing reordered or duplicated.
    expect(replayed.map(e => e.ts)).toEqual(
      Array.from({ length: BUFFER_CAP }, (_, i) => total - BUFFER_CAP + i),
    )
  })

  it('keeps producing the newest N in order after wrapping past capacity more than once', () => {
    const forwarder = makeForwarder()
    const total = BUFFER_CAP * 2 + 7
    for (let i = 0; i < total; i++) forwarder.emit(entry(i))

    const replayed: GuestConsoleEntry[] = []
    forwarder.subscribe(e => replayed.push(e), { replay: true })

    expect(replayed.map(e => e.ts)).toEqual(
      Array.from({ length: BUFFER_CAP }, (_, i) => total - BUFFER_CAP + i),
    )
  })

  it('a non-replaying subscriber never receives buffered history, only live entries', () => {
    const forwarder = makeForwarder()
    for (let i = 0; i < 10; i++) forwarder.emit(entry(i))

    const received: GuestConsoleEntry[] = []
    forwarder.subscribe(e => received.push(e))
    forwarder.emit(entry(10))

    expect(received.map(e => e.ts)).toEqual([10])
  })
})
