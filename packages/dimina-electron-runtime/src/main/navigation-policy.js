import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Pairs a webview's pre-creation policy with its eventual guest WebContents.
 * Electron exposes the source only in `will-attach-webview`; a cancelled
 * attach never emits `did-attach-webview`, so cancelled entries are removed
 * before the next attach can consume them.
 */
export class PendingWebviewAttachments {
    #pending = [];
    willAttach(event, value) {
        const entry = { event, value };
        this.#pending.push(entry);
        queueMicrotask(() => {
            if (!event.defaultPrevented)
                return;
            const index = this.#pending.indexOf(entry);
            if (index >= 0)
                this.#pending.splice(index, 1);
        });
    }
    didAttach() {
        return this.#pending.shift()?.value;
    }
}
export function allowSimulatorNavigation(target, simulatorUrl) {
    try {
        const url = new URL(target);
        return url.href === 'about:blank' || url.origin === new URL(simulatorUrl).origin;
    }
    catch {
        return false;
    }
}
export function allowRenderNavigation(target, expectedFrameUrl) {
    try {
        const url = new URL(target);
        const expected = new URL(expectedFrameUrl);
        return expected.protocol === 'dmb-resource:' && expected.hostname.length > 0
            && expected.pathname.endsWith('/__frame__.html')
            && url.protocol === expected.protocol && url.hostname === expected.hostname && url.pathname === expected.pathname && url.search === expected.search;
    }
    catch {
        return false;
    }
}
/** A service realm may only keep its configured runtime document. */
export function allowServiceHostNavigation(target, serviceHostHtmlPath) {
    try {
        const url = new URL(target);
        if (url.href === 'about:blank')
            return true;
        return url.protocol === 'file:'
            && path.resolve(fileURLToPath(url)) === path.resolve(serviceHostHtmlPath);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=navigation-policy.js.map