import type { DeviceProfile } from '@devicekit/devices'
import type { ProjectStatus } from '@/shared/api'

/** Values shared by the project-runtime leaf hooks without importing the controller. */
export type CompileStatus = ProjectStatus
export type DeviceType = DeviceProfile
