/**
 * Pairs a webview's pre-creation policy with its eventual guest WebContents.
 * Electron exposes the source only in `will-attach-webview`; a cancelled
 * attach never emits `did-attach-webview`, so cancelled entries are removed
 * before the next attach can consume them.
 */
export declare class PendingWebviewAttachments<T> {
    #private;
    willAttach(event: {
        defaultPrevented?: boolean;
    }, value: T): void;
    didAttach(): T | undefined;
}
export declare function allowSimulatorNavigation(target: string, simulatorUrl: string): boolean;
export declare function allowRenderNavigation(target: string, expectedFrameUrl: string): boolean;
/** A service realm may only keep its configured runtime document. */
export declare function allowServiceHostNavigation(target: string, serviceHostHtmlPath: string): boolean;
//# sourceMappingURL=navigation-policy.d.ts.map