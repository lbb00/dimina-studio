import { describe, expect, it } from 'vitest'
import { withSimulatorFloor } from './simulator-constraint'

describe('withSimulatorFloor', () => {
  it('changes only the device floor and retains the user preferred size', () => {
    expect(withSimulatorFloor({ minPx: 379, preferredPx: 456 }, 243)).toEqual({
      minPx: 243,
      preferredPx: 456,
    })
  })

  it('does not invent a preference for a default-sized panel', () => {
    expect(withSimulatorFloor({ minPx: 379 }, 243)).toEqual({ minPx: 243 })
  })
})
