import type { AppManifest, PageWindowConfig } from '../../shared/bridge-channels.js'
import type { RawAppConfig } from './bridge-router-types.js'

// ── App-config / manifest parsing ───────────────────────────────────────────

/**
 * Fetch+parse `app-config.json`. Pure (no `ctx`, no diagnostics dependency) —
 * a non-2xx response or a parse/network failure reports through `onUnreachable`
 * (the caller routes it into `ctx.diagnostics`) and returns `{}` either way, so
 * the spawn flow always continues with a manifest that just falls back to a
 * single-page/no-tabBar shape (`buildAppManifest`'s fallback).
 */
export async function loadAppConfig(
  resourceBase: string,
  onUnreachable?: (info: { url: string; error: unknown }) => void,
): Promise<RawAppConfig> {
  // `resourceBase` is the dir/URL that directly contains `app-config.json`:
  // the dev server's `<base><appId>/<root>/` (http) or the local fallback
  // server root (also http). Both are HTTP, so a single fetch path covers them.
  const cfgUrl = new URL(
    'app-config.json',
    resourceBase.endsWith('/') ? resourceBase : `${resourceBase}/`,
  ).toString()
  try {
    const res = await fetch(cfgUrl)
    if (!res.ok) {
      const error = new Error(`app-config.json fetch ${res.status} at ${cfgUrl}`)
      console.warn(`[bridge-router] no app-config.json at ${cfgUrl} (${res.status})`)
      onUnreachable?.({ url: cfgUrl, error })
      return {}
    }
    return (await res.json()) as RawAppConfig
  } catch (error) {
    console.warn('[bridge-router] failed to fetch/parse app-config.json:', error)
    onUnreachable?.({ url: cfgUrl, error })
    return {}
  }
}

export function buildAppManifest(appConfig: RawAppConfig, fallbackEntry: string): AppManifest {
  const compiledPages = appConfig.app?.pages ?? []
  const hasCompiledPages = compiledPages.length > 0
  // `entryPagePath` is the APP's own home page — the nav-bar home button's
  // target and the page its visibility rule compares against. A compiled app
  // always has one of its own (declared `entryPagePath`, else `pages[0]`), so
  // the requested launch page may only fill in for a 'fallback' manifest:
  // launching into an inner page must not make that page masquerade as home.
  // A declared entry outside `pages` is unmountable (most often a page deleted
  // without updating app.json), so it loses to `pages[0]` — the same rule
  // `resolveRootPagePath` applies to a launch request.
  const declaredEntry = appConfig.app?.entryPagePath
  const entryIsMember =
    !!declaredEntry &&
    compiledPages.some(page => normalizePagePath(page) === normalizePagePath(declaredEntry))
  const entry = entryIsMember ? declaredEntry! : compiledPages[0] || fallbackEntry
  const pages = hasCompiledPages ? compiledPages : [entry]
  const tabBar =
    appConfig.app?.tabBar &&
    Array.isArray(appConfig.app.tabBar.list) &&
    appConfig.app.tabBar.list.length > 0
      ? appConfig.app.tabBar
      : undefined
  return {
    entryPagePath: normalizePagePath(entry),
    pages: pages.map(normalizePagePath),
    tabBar,
    // 'app-config' means `pages` above is the real compiled list mount gates
    // can trust; 'fallback' means app-config.json was unreachable and `pages`
    // is just the single requested page — nothing to validate membership
    // against, so every gate keyed on this source lets it through unchanged.
    source: hasCompiledPages ? 'app-config' : 'fallback',
  }
}

/**
 * Resolve the root page a spawn actually mounts against the compiled
 * manifest. The request is trusted verbatim unless the manifest is a real
 * compiled one (`source === 'app-config'`) AND the request is absent from its
 * `pages` — in that case the request is unmountable (most commonly a start
 * page removed by a hot reload) and resolution falls back to
 * `manifest.entryPagePath`, or `manifest.pages[0]` when even the entry isn't a
 * member. A `'fallback'` manifest contains only the request itself, so there
 * is trivially nothing to fall back from.
 */
export function resolveRootPagePath(
  manifest: AppManifest,
  requestedPagePath: string,
): { resolvedPagePath: string; pageFallbackApplied: boolean } {
  if (manifest.source !== 'app-config' || manifest.pages.includes(requestedPagePath)) {
    return { resolvedPagePath: requestedPagePath, pageFallbackApplied: false }
  }
  const resolvedPagePath = manifest.pages.includes(manifest.entryPagePath)
    ? manifest.entryPagePath
    : (manifest.pages[0] ?? manifest.entryPagePath)
  return { resolvedPagePath, pageFallbackApplied: true }
}

export function resolvePageWindowConfig(appConfig: RawAppConfig, pagePath: string): PageWindowConfig {
  const normalized = normalizePagePath(pagePath)
  const appWindow = appConfig.app?.window ?? {}
  const pageWindow = appConfig.modules?.[normalized] ?? {}
  return {
    navigationBarTitleText:
      pageWindow.navigationBarTitleText ?? appWindow.navigationBarTitleText ?? '',
    navigationBarBackgroundColor:
      pageWindow.navigationBarBackgroundColor ??
      appWindow.navigationBarBackgroundColor ??
      '#ffffff',
    navigationBarTextStyle:
      pageWindow.navigationBarTextStyle ?? appWindow.navigationBarTextStyle ?? 'black',
    navigationStyle: pageWindow.navigationStyle ?? appWindow.navigationStyle ?? 'default',
    homeButton: pageWindow.homeButton ?? appWindow.homeButton,
    backgroundColor: pageWindow.backgroundColor ?? appWindow.backgroundColor,
    backgroundTextStyle: pageWindow.backgroundTextStyle ?? appWindow.backgroundTextStyle,
    enablePullDownRefresh: pageWindow.enablePullDownRefresh ?? appWindow.enablePullDownRefresh,
    disableScroll: pageWindow.disableScroll ?? appWindow.disableScroll,
  }
}

export function isTabPage(appConfig: RawAppConfig, pagePath: string): boolean {
  const list = appConfig.app?.tabBar?.list ?? []
  const normalized = normalizePagePath(pagePath)
  return list.some(item => normalizePagePath(item.pagePath) === normalized)
}

export function normalizePagePath(p: string): string {
  return p ? p.replace(/^\/+/, '') : ''
}
