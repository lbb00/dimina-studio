import { describe, expect, it } from 'vitest'
import { DEVICE_NAMES, findDevice } from '@devicekit/devices'
import { frameOuterSize } from '@devicekit/frame'
import { ZOOM_OPTIONS } from '@/shared/constants'
import { SimulatorAttachNativeSchema } from '../../../../../../shared/ipc-schemas'
import { computeSimPanelWidth } from './device-geometry'

describe('computeSimPanelWidth', () => {
  it('emits every fixed device/zoom width accepted by native simulator attach IPC', () => {
    const rejected: string[] = []

    for (const name of Object.values(DEVICE_NAMES)) {
      const device = findDevice(name)
      expect(device, `device catalog entry ${name} must resolve`).toBeDefined()
      const frameWidth = frameOuterSize(device!, 'portrait').width
      for (const zoom of ZOOM_OPTIONS) {
        const width = computeSimPanelWidth(frameWidth, zoom)
        if (!SimulatorAttachNativeSchema.safeParse(['http://127.0.0.1:3000/simulator.html', width]).success) {
          rejected.push(`${name}@${zoom}=${width}`)
        }
      }
    }

    expect(rejected).toEqual([])
  })
})
