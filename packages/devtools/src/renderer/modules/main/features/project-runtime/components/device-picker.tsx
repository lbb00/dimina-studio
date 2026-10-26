import { useEffect, useMemo, useRef } from 'react'
import { Check } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/components/ui/command'
import { cn } from '@/shared/lib/utils'
import type { DeviceOS, DeviceProfile } from '@devicekit/devices'

// Groups mirror DEVICES' own os ordering (iOS → Android → HarmonyOS).
const OS_GROUPS: Array<{ os: DeviceOS; label: string }> = [
  { os: 'ios', label: 'iOS' },
  { os: 'android', label: 'Android' },
  { os: 'harmony', label: 'HarmonyOS' },
]

/**
 * Search haystack for cmdk's built-in fuzzy filter, one string per device so
 * "14 pro", "android 14", and "390" all resolve to the same matches. The size
 * is indexed both as typed on a keyboard ("393x852") and as the row displays
 * it ("393×852"), since cmdk's filter does not fold the two characters.
 */
export function buildSearchValue(d: DeviceProfile): string {
  const { width, height } = d.screen
  return [d.name, d.system ?? '', `${width}x${height}`, `${width}×${height}`].join(' ')
}

interface DevicePickerProps {
  device: DeviceProfile
  devices: readonly DeviceProfile[]
  onSelect: (name: string) => void
  /** Dismissed without picking (Escape, or a click on the backdrop). */
  onClose: () => void
}

/**
 * Searchable panel over the full device table, always open: it is mounted by
 * the device-picker overlay WebContentsView for exactly as long as that panel
 * is shown, and the trigger button lives in the toolbar's own renderer, one
 * WebContents away. Free-text search is handled by cmdk against
 * `buildSearchValue` while system groups keep the complete table scannable.
 */
export function DevicePicker({ device, devices, onSelect, onClose }: DevicePickerProps) {
  const currentRowRef = useRef<HTMLDivElement>(null)

  // cmdk mounts the list synchronously with the dialog (no lazy content), so
  // the current row's ref is already attached on this first effect run.
  useEffect(() => {
    const el = currentRowRef.current
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' })
    }
  }, [])

  const filtered = useMemo(
    () => [...devices].sort((a, b) => (b.releaseYear ?? 0) - (a.releaseYear ?? 0)),
    [devices],
  )

  const groups = useMemo(
    () =>
      OS_GROUPS.map((g) => ({ ...g, devices: filtered.filter((d) => d.os === g.os) })).filter(
        (g) => g.devices.length > 0,
      ),
    [filtered],
  )

  return (
    <>
      {/* Pre-highlight the current device so Enter on a fresh open keeps it
          instead of jumping to the first row of the list. */}
      <CommandDialog
        open
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
        title="选择机型"
        commandProps={{ defaultValue: buildSearchValue(device) }}
      >
        <CommandInput placeholder="搜索机型" autoFocus />
        <CommandList>
          <CommandEmpty>没有匹配的机型</CommandEmpty>
          {groups.map((g) => (
            <CommandGroup key={g.os} heading={g.label}>
              {g.devices.map((d) => {
                const isCurrent = d.name === device.name
                return (
                  <CommandItem
                    key={d.name}
                    ref={isCurrent ? currentRowRef : undefined}
                    value={buildSearchValue(d)}
                    aria-label={d.name}
                    data-current={isCurrent || undefined}
                    onSelect={() => onSelect(d.name)}
                    className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Check
                        className={cn('size-3.5 shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')}
                      />
                      <span className="truncate" title={d.name}>{d.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {d.screen.width}×{d.screen.height}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">仅支持竖屏</p>
      </CommandDialog>
    </>
  )
}
