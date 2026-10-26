import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createViewAnchor,
  type Bounds,
  type Placement,
  type ViewAnchorHandle,
} from "view-anchor";
import { usePlacementPublisher } from '@/shared/placement-publisher-context';
import { VIEW_ID, VIEW_LAYER } from "../../../../../../shared/view-ids";
import { useDockLayoutEpoch } from "electron-deck/dock-react";
import { cn } from "@/shared/lib/utils";
import {
  AUTO_ZOOM,
  SIM_PANEL_PADDING,
  ZOOM_OPTIONS,
  type ZoomSetting,
} from "@/shared/constants";
import { frameOuterSize } from "@devicekit/frame";
import {
  type DeviceProfile,
} from "@devicekit/devices";
import { Button } from "@/shared/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/shared/components/ui/native-select";
import {
  FallbackBanner,
  RuntimeErrorOverlay,
  WatcherDeadBar,
  type SimulatorRuntimeStatus,
} from "./simulator-runtime-banners";

interface SimulatorPanelProps {
  device: DeviceProfile;
  zoom: ZoomSetting;
  /** Opens the device-picker overlay. The device list is NOT in this
   * renderer's DOM: the simulator WCV is mounted over this panel and would cut
   * a centered dialog in half (see view-ids.ts's VIEW_LAYER doc-comment), so
   * the panel keeps only the trigger and the picked device arrives at the
   * device-state owner (use-device.ts) as an IPC push. */
  onOpenDevicePicker: () => void;
  onZoomChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  compileStatus: { status: string; message: string };
  /** Visible page as `pagePath?k=v&…`, shown in the page-path bar with params
   * (WeChat DevTools shows the route the same way). Empty when unknown. */
  currentPage: string;
  copied: boolean;
  onCopyPagePath: () => void;
  /** Latest runtime-lifecycle push for the active session; null when healthy/unreported. Optional for embedders that don't wire runtime-status (defaults to null: no overlay/banner). */
  runtimeStatus?: SimulatorRuntimeStatus | null;
  /** True once the project's file watcher has died for this session. */
  watcherDead?: boolean;
  /** Re-runs the current launch config (the toolbar's existing 刷新/relaunch action). */
  onRelaunch?: () => void;
  /** Opens the standalone internal (app-wide) DevTools debug window. Unlike
   * the page-path copy button, debugging the whole app is independent of the
   * current page, so the button always renders. */
  onOpenInternalDevtools?: () => void;
}

// DeviceShell's scrollable desk reserves SIM_PANEL_PADDING on each edge around
// the frame's outer box (screen + bezel + border, see frameOuterSize). Auto-fit
// must include this fixed margin or a phone that numerically matches its region
// still overflows by a few pixels.
const AUTO_FIT_FRAME = 2 * SIM_PANEL_PADDING;

// Resolves the auto-fit zoom percent from the measured device-region box: the
// largest whole-percent scale (capped at 100) that lets the framed device fit
// inside `bounds` without cropping either axis. Rounding down deliberately
// leaves a small safety margin, avoiding a native scrollbar from fractional
// device-pixel rounding. A zero-area measurement (unstable first layout, or a
// treatZeroAreaAsHidden hidden tick) returns `fallback` unchanged instead of
// collapsing to 0.
function computeAutoZoom(
  bounds: Bounds,
  frame: { width: number; height: number },
  fallback: number,
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return fallback;
  const ratio = Math.min(
    bounds.width / (frame.width + AUTO_FIT_FRAME),
    bounds.height / (frame.height + AUTO_FIT_FRAME),
  );
  return Math.max(1, Math.min(100, Math.floor(ratio * 100)));
}

export function SimulatorPanel({
  device,
  zoom,
  onOpenDevicePicker,
  onZoomChange,
  compileStatus,
  currentPage,
  copied,
  onCopyPagePath,
  runtimeStatus = null,
  watcherDead = false,
  onRelaunch = () => {},
  onOpenInternalDevtools = () => {},
}: SimulatorPanelProps) {
  // The simulator is a main-process WebContentsView (native-host is the sole
  // runtime) painted directly over the flex:1 placeholder below. This renderer
  // panel draws NO phone/bezel: just the toolbar, an EMPTY placeholder slot, and
  // the page-path bar. Inside the WCV, DeviceShell draws the WHOLE phone (rounded
  // corners, notch, nav, viewport, tab/home) at FIXED device-logical size and
  // scrolls it natively when larger than the region. zoom is applied as the
  // WCV's zoomFactor (zoom/100), never as a CSS transform here.
  //
  // This component is the SOLE simulator-WCV anchor owner. It binds an imperative
  // `createViewAnchor` to the device-region div (NOT the engine-agnostic
  // `useViewAnchor`). 尺寸变化由 anchor 的观察器测量；dock 布局提交后通过
  // update() 立即重测位置，覆盖尺寸不变的移动。The WCV is
  // a main-process child view. Under DOM-panel keepalive (A3) SimulatorPanel is
  // NOT unmounted when its dock tab deactivates — its slot merely goes
  // `display:none` — so there is no unmount path to publish hidden on a tab
  // switch. To collapse the WCV on deactivation it opts into view-anchor's
  // `treatZeroAreaAsHidden`: that installs an IntersectionObserver which re-fires on a
  // `display:none` transition (invisible to ResizeObserver) and turns the
  // resulting zero-area measure into a `{ visible:false }` publish, which the
  // `publish` callback below maps to COLLAPSED 0×0 bounds (detaching the WCV).
  // The true unmount path still publishes hidden + disposes as a safety net.
  //
  // Zoom rides in the publish payload (the `Placement` rect has no zoom field) so
  // main can `setZoomFactor` the WCV; it is kept in a ref so the imperative
  // publisher always reads the LIVE value, and a zoom change forces one
  // re-publish.
  // Holds the last RESOLVED numeric zoom (never AUTO_ZOOM) — what actually
  // rides in the publish payload. Seeded with a number even when the initial
  // selection is 'auto', so the very first publish (before any measurement)
  // never carries a non-numeric value across the extra.zoom → IPC boundary.
  const zoomRef = useRef<number>(typeof zoom === "number" ? zoom : 100);
  // The user's raw selection (a fixed percent, or 'auto'). Read live inside
  // `publish` via ref so that callback's identity can stay pinned to
  // `[publisher]` instead of being recreated on every zoom change.
  const zoomModeRef = useRef<ZoomSetting>(zoom);
  // Device, read live inside `publish` for the same reason.
  const deviceRef = useRef(device);
  const anchorHandleRef = useRef<ViewAnchorHandle | null>(null);

  // Whether the simulator has reached 'ready' at least once since mount. The
  // first compile has NOTHING to show behind it, so 'compiling' blanks the
  // region with a full overlay. A RECOMPILE, by contrast, keeps the live phone
  // shell painted underneath — blanking it would flash the whole device away on
  // every save. So once ready, a subsequent 'compiling' shows only a
  // non-blocking corner indicator and the frozen previous frame stays visible.
  const [hasBeenReady, setHasBeenReady] = useState(false);
  useEffect(() => {
    if (compileStatus.status === "ready") setHasBeenReady(true);
  }, [compileStatus.status]);

  // Runtime-lifecycle derived flags. A compile failure has nothing running to
  // report on, so it always wins over a runtime error — the two overlays are
  // mutually exclusive.
  const isRuntimeTerminalError =
    runtimeStatus?.phase === "launch-failed" ||
    runtimeStatus?.phase === "crashed";

  // Fallback-banner dismissal: remembered only for the CURRENT launch round.
  // `runtimeStatus` is reset to null the moment a new round starts (hot-reload
  // reset in use-session), so clearing the dismissal on that null edge means a
  // repeat fallback in a later round is never silently swallowed.
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  useEffect(() => {
    if (!runtimeStatus) setFallbackDismissed(false);
  }, [runtimeStatus]);
  const showFallbackBanner =
    Boolean(runtimeStatus?.pageFallback) &&
    !isRuntimeTerminalError &&
    !fallbackDismissed;
  const isRecompile = compileStatus.status === "compiling" && hasBeenReady;

  const publisher = usePlacementPublisher();
  const layoutEpoch = useDockLayoutEpoch();
  // Placement flows to the central publisher; zoom rides in `extra` (the
  // Placement bounds have no zoom field) so an extra-only change still emits a
  // setBounds op that re-applies the WCV zoomFactor.
  const publish = useCallback(
    (p: Placement) => {
      if (p.visible) {
        const mode = zoomModeRef.current;
        zoomRef.current =
          mode === AUTO_ZOOM
            ? computeAutoZoom(
                p.bounds,
                frameOuterSize(deviceRef.current, "portrait"),
                zoomRef.current,
              )
            : mode;
      }
      publisher?.set({
        viewId: VIEW_ID.simulator,
        placement: p,
        layer: VIEW_LAYER.base,
        extra: { zoom: zoomRef.current },
      });
    },
    [publisher],
  );

  // Ref-callback binding the placement anchor to the device-region div. Mirrors
  // the dock native-slot lifecycle: bind on mount, rebind without a hidden flash
  // on element swap, publish-hidden-then-dispose on unmount.
  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      const existing = anchorHandleRef.current;
      if (existing) {
        if (el) {
          existing.dispose();
          anchorHandleRef.current = createViewAnchor(el, {
            visible: true,
            followGeometry: true,
            treatZeroAreaAsHidden: true,
            publish,
          });
        } else {
          existing.update({ visible: false, publish });
          existing.dispose();
          anchorHandleRef.current = null;
        }
        return;
      }
      if (el) {
        anchorHandleRef.current = createViewAnchor(el, {
          visible: true,
          followGeometry: true,
          treatZeroAreaAsHidden: true,
          publish,
        });
      }
    },
    [publish],
  );

  // Keep the live zoom in the ref BEFORE paint (so a geometry event firing
  // between commit and a passive effect never reads a stale zoom), then force one
  // re-publish so main re-applies `setZoomFactor` on zoom change.
  useLayoutEffect(() => {
    zoomModeRef.current = zoom;
    deviceRef.current = device;
  });
  useLayoutEffect(() => {
    anchorHandleRef.current?.update({
      visible: true,
      followGeometry: true,
      treatZeroAreaAsHidden: true,
      publish,
    });
  }, [zoom, device, layoutEpoch, publish]);

  // Hard-unmount safety: the ref-callback `null` cleanup also disposes, but a
  // teardown that skips the ref cleanup must not leak a live anchor.
  useEffect(() => {
    return () => {
      anchorHandleRef.current?.dispose();
      anchorHandleRef.current = null;
      publisher?.remove(VIEW_ID.simulator);
    };
  }, [publisher]);

  return (
    <div className="bg-sim-bg flex flex-col overflow-hidden h-full w-full">
      <div className="flex flex-wrap items-center gap-2 px-5 py-2 shrink-0 border-b border-border">
        {/* The label is the selected device's own name, so it is not a stable
            handle for tests or automation — `data-testid` is, like the
            compile-mode button next to it. */}
        <Button
          variant="outline"
          size="sm"
          data-testid="device-picker-button"
          className="h-7 min-w-0 max-w-full truncate justify-start px-2 text-[13px] font-medium text-muted-foreground"
          onClick={onOpenDevicePicker}
        >
          {device.name}
        </Button>
        <NativeSelect value={zoom} onChange={onZoomChange} className="h-7 w-[76px] shrink-0 px-2 text-[13px] font-medium">
          {ZOOM_OPTIONS.map((z) => (
            <NativeSelectOption key={z} value={z}>{z}%</NativeSelectOption>
          ))}
          <NativeSelectOption value={AUTO_ZOOM}>自适应</NativeSelectOption>
        </NativeSelect>
      </div>

      {/* Persistent, never covers the device region below (contract: "不遮内容"). */}
      {watcherDead && <WatcherDeadBar />}
      {showFallbackBanner && runtimeStatus?.pageFallback && (
        <FallbackBanner
          requested={runtimeStatus.pageFallback.requested}
          resolved={runtimeStatus.pageFallback.resolved}
          onDismiss={() => setFallbackDismissed(true)}
        />
      )}

      <div
        ref={anchorRef}
        className="flex-1 min-h-0 bg-sim-bg relative"
        data-area="native-simulator"
        data-deck-viewport
      >
        {/* The simulator itself is a main-process WebContentsView (mounted via
            attachNativeSimulator) painted over this placeholder region — it
            hosts DeviceShell, which draws the whole phone and scrolls it
            natively, so the renderer never renders a `<webview>` here. */}
        {compileStatus.status === "compiling" && !hasBeenReady && (
          <div
            data-testid="sim-compiling-overlay"
            className="absolute inset-0 flex items-center justify-center bg-[var(--color-overlay)] z-10"
          >
            <div
              data-testid="sim-compiling-surface"
              className="rounded-md border border-border bg-popover px-4 py-3 text-[13px] text-popover-foreground shadow-lg"
            >
              正在编译中...
            </div>
          </div>
        )}
        {isRecompile && (
          <div
            data-testid="sim-recompiling-indicator"
            data-surface="sim-recompiling-surface"
            className="absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-0.5 text-popover-foreground shadow-sm pointer-events-none"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-status-warn animate-pulse" />
            <span className="text-xs">编译中…</span>
          </div>
        )}
        {compileStatus.status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-overlay-heavy)] z-10">
            <div
              data-testid="sim-compile-error-surface"
              className="rounded-md border border-status-error bg-danger-bg p-4 text-center shadow-lg"
            >
              <div className="text-status-error text-[14px] font-medium mb-2">
                编译失败
              </div>
              <div className="text-status-error text-[11px] max-w-[280px] break-words">
                {compileStatus.message}
              </div>
            </div>
          </div>
        )}
        {/* Compile failure always wins when both are true. */}
        {compileStatus.status !== "error" &&
          runtimeStatus &&
          (runtimeStatus.phase === "launch-failed" ||
            runtimeStatus.phase === "crashed") && (
            <RuntimeErrorOverlay
              phase={runtimeStatus.phase}
              code={runtimeStatus.code}
              reason={runtimeStatus.reason}
              onRelaunch={onRelaunch}
            />
          )}
      </div>

      <div className="flex items-center px-2.5 bg-sim-bottom border-t border-border shrink-0 h-[30px] min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={currentPage || undefined}
          >
            {currentPage || "—"}
          </span>
          {currentPage && (
            <button
              className={cn(
                "shrink-0 flex items-center justify-center w-4 h-4 rounded transition-colors",
            copied ? "text-accent" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={onCopyPagePath}
              title="复制路径"
            >
              {copied ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline
                    points="1.5,5 4,7.5 8.5,2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect
                    x="1"
                    y="3"
                    width="6"
                    height="6.5"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                  <path
                    d="M3 3V2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H7"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                </svg>
              )}
            </button>
          )}
        </div>

        {/* Opens the standalone internal (app-wide) DevTools debug window —
            debugs the whole Electron app + top-level info, separate from the
            right-panel CDP that inspects the user's mini-program. Always
            rendered: unlike the page-path copy button, it's independent of
            the current page. */}
        <button
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          onClick={onOpenInternalDevtools}
          title="调试开发者工具"
          data-testid="sim-open-internal-devtools"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <rect
              x="3"
              y="3.5"
              width="5"
              height="5.5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1"
            />
            <path
              d="M4 3.5V3a1.5 1.5 0 013 0v.5M1.5 5.5H3M8 5.5h1.5M2 8.5l1.3-1M9 8.5l-1.3-1M2 3l1.3 1M9 3L7.7 4"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
