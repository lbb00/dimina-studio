/**
 * Published fetch-based compatibility helper for external embedders. DevTools'
 * request entrypoints use main/services/native-request; timeout constants remain
 * shared with that transport and the simulator forwarding watchdog.
 *
 * The contract (official wx.request semantics):
 *  - success vs fail is decided ONLY by whether a server response was
 *    received. Any HTTP response — 200, 401, 500 — resolves via `success`
 *    with `{ data, statusCode, header, errMsg: 'request:ok' }`; callers
 *    branch on `statusCode` (e.g. 401 → re-login).
 *  - `fail` fires only for network-layer failures and always carries a
 *    non-empty errMsg: 'request:fail timeout' (deadline hit),
 *    'request:fail abort' (caller aborted), 'request:fail <reason>' (DNS/
 *    connection/protocol errors).
 *  - `timeout` defaults to 60000ms (the wx default) when omitted or
 *    non-positive — a request never hangs indefinitely.
 *  - `dataType` (default 'json') controls body decoding: 'json' attempts
 *    JSON.parse with raw-text fallback; anything else keeps raw text.
 *    `responseType: 'arraybuffer'` (or the legacy `dataType: 'arraybuffer'`
 *    spelling) yields an ArrayBuffer instead.
 *  - Outgoing headers merge case-insensitively via `Headers` so a caller's
 *    `content-type` in any casing wins exactly once; the `application/json`
 *    default applies only when the caller supplied none AND the request will
 *    actually carry a body (a method other than GET, HEAD, or DELETE, with
 *    `data`). A bodyless GET/HEAD/DELETE gets no default content-type —
 *    matching what a real device sends — so it stays a CORS-simple request
 *    instead of forcing a preflight the simulator's Chromium renderer would
 *    otherwise send. Plain-object merges would keep both casings as distinct
 *    keys and comma-join them on the wire.
 *  - GET/HEAD/DELETE serialize a plain-object `data` into the URL query and
 *    send no body (repeated keys for arrays, nullish fields omitted, hash
 *    kept). Other methods send string data verbatim, form-encode objects under
 *    application/x-www-form-urlencoded, and JSON-encode otherwise.
 *  - `complete` fires exactly once, after success or fail, with that same
 *    result object.
 *
 * Not provided: `cookies` on the success result — fetch() cannot read
 * Set-Cookie response headers, so surfacing a fabricated list would lie.
 */
import { buildHeaders, encodeBody } from "./request-encoding.js";

export interface RequestSuccessResult {
  data: unknown;
  statusCode: number;
  header: Record<string, string>;
  errMsg: "request:ok";
}

export interface RequestFailResult {
  errMsg: string;
  errno?: number;
}

export interface RequestHandle {
  abort(): void;
}

export interface RequestCoreOptions {
  url: string;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
  method?: string;
  dataType?: string;
  responseType?: string;
}

export interface RequestCoreCallbacks {
  success?: (res: RequestSuccessResult) => void;
  fail?: (err: RequestFailResult) => void;
  complete?: (res: RequestSuccessResult | RequestFailResult) => void;
}

/**
 * The wx.request default timeout budget. Exported as the single source of
 * truth for every layer that reasons about a request's time budget — the
 * bridge-router watchdog (apiCallWatchdogMs in simulator-api-metadata.ts)
 * derives its window from this so the two cannot drift apart.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Largest delay setTimeout honours (2^31-1 ms). Anything above overflows the
 * signed-32-bit timer register and fires ~immediately (~1ms) instead of late —
 * so an oversized caller timeout must be rejected, never passed through.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve a caller-supplied wx timeout into a usable budget: a finite positive
 * number within setTimeout's range is honoured; anything else (absent, 0,
 * negative, NaN, Infinity, overflowing) falls back to the wx default. Shared
 * by performRequest and the bridge-router watchdog (apiCallWatchdogMs) so the
 * two layers can never disagree on what a valid timeout is.
 */
export function resolveTimeoutBudgetMs(timeout: unknown): number {
  const t = Number(timeout);
  return Number.isFinite(t) && t > 0 && t <= MAX_TIMEOUT_MS
    ? t
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

function isPlainDataObject(data: unknown): data is Record<string, unknown> {
  return Object.prototype.toString.call(data) === "[object Object]";
}

/** Absolute urls stay byte-for-byte; a relative url resolves against the document. */
function urlForQuery(url: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    const baseHref = typeof location !== "undefined" ? location.href : undefined;
    if (!baseHref) return url;
    try {
      return new URL(url, baseHref).toString();
    } catch {
      return url;
    }
  }
}

/**
 * Plain-object query encoding: repeated keys for arrays, nullish fields and
 * array items omitted, an existing '?' joined with '&' unless the url already
 * ends in '?' or '&', and the hash left in place.
 */
function appendObjectQuery(url: string, data: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && item !== undefined) {
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
    }
  }
  if (pairs.length === 0) return url;
  const target = urlForQuery(url);
  const hashIndex = target.indexOf("#");
  const fragment = hashIndex < 0 ? "" : target.slice(hashIndex);
  const base = hashIndex < 0 ? target : target.slice(0, hashIndex);
  const separator = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?";
  return `${base}${separator}${pairs.join("&")}${fragment}`;
}

async function decodeResponseData(
  response: Response,
  dataType: string,
  responseType: string,
): Promise<unknown> {
  if (responseType === "arraybuffer" || dataType === "arraybuffer") {
    return response.arrayBuffer();
  }
  const text = await response.text();
  if (dataType !== "json") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @deprecated No longer called by devtools' own wx.request path — that now
 * runs through `main/services/native-request` (Node http/https in the main
 * process), so it never participates in Chromium's Fetch/CORS algorithm.
 * Kept here only because `./shared/request-core` is a published npm subpath
 * export of `@dimina-studio/electron-runtime` (an embeddable package) — an
 * external embedder could import this directly. Do not wire this back into
 * any devtools call site. Service wx.request reaches native-request through
 * the simulator API bridge (`request` / `requestTaskAbort`).
 */
export function performRequest(
  opts: RequestCoreOptions,
  callbacks: RequestCoreCallbacks,
): RequestHandle {
  const method = (opts.method || "GET").toUpperCase();
  const sendsQuery = method === "GET" || method === "HEAD" || method === "DELETE";
  // A plain object on GET/HEAD/DELETE is the query. Any other DELETE payload
  // stays on the body. GET/HEAD never gain a body from non-object data.
  const plainQuery = sendsQuery && isPlainDataObject(opts.data);
  const willSendBody = opts.data != null && !plainQuery && method !== "GET" && method !== "HEAD";
  const headers = buildHeaders(opts.header, willSendBody);

  let url = opts.url;
  const init: RequestInit = { method, headers };

  if (sendsQuery && isPlainDataObject(opts.data)) url = appendObjectQuery(url, opts.data);
  else if (willSendBody) init.body = encodeBody(opts.data, headers.get("content-type") ?? "");

  const controller = new AbortController();
  init.signal = controller.signal;

  // First verdict wins: a timeout/abort settles the call even though the fetch
  // promise is still pending, and the fetch's own late resolution/AbortError
  // rejection must not fire a second callback round.
  let settled = false;

  function settleSuccess(res: RequestSuccessResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callbacks.success?.(res);
    callbacks.complete?.(res);
  }

  function settleFail(err: RequestFailResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callbacks.fail?.(err);
    callbacks.complete?.(err);
  }

  const timeoutMs = resolveTimeoutBudgetMs(opts.timeout);
  const timer = setTimeout(() => {
    settleFail({ errMsg: "request:fail timeout" });
    controller.abort();
  }, timeoutMs);

  const dataType = opts.dataType ?? "json";
  const responseType = opts.responseType ?? "text";

  fetch(url, init)
    .then(async (response) => {
      const header: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        header[key] = value;
      });
      const data = await decodeResponseData(response, dataType, responseType);
      settleSuccess({
        data,
        statusCode: response.status,
        header,
        errMsg: "request:ok",
      });
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      settleFail({ errMsg: `request:fail ${reason || "network error"}` });
    });

  return {
    abort() {
      settleFail({ errMsg: "request:fail abort" });
      controller.abort();
    },
  };
}
