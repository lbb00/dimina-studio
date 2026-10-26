import React, { useMemo, useState, useCallback } from 'react'
import JsonView from '@uiw/react-json-view'
import { darkTheme } from '@uiw/react-json-view/dark'
import { Input } from '@/shared/components/ui/input'
import { cn } from '@/shared/lib/utils'

export interface JsonViewerProps {
  /** The JSON data to display. */
  data: Record<string, unknown> | unknown[] | null | undefined
  /** Label shown above the viewer. */
  label?: string
  /** Initial collapse depth. 0 = all collapsed, Infinity = all expanded. Default 2. */
  initialDepth?: number
  /** Enable the search / filter input. Default true. */
  searchable?: boolean
  /** Show the object path tooltip on hover. Default true. */
  showPath?: boolean
  /** Additional CSS class names for the outer wrapper. */
  className?: string
}

/**
 * Custom dark theme that integrates with the workbench design tokens.
 * Extends the base dark theme from @uiw/react-json-view.
 */
const workbenchTheme: React.CSSProperties = {
  ...darkTheme,
  '--w-rjv-font-family': 'var(--font-family-mono)',
  '--w-rjv-background-color': 'var(--muted)',
  '--w-rjv-color': 'var(--foreground)',
  '--w-rjv-key-string': 'var(--color-code-blue)',
  '--w-rjv-info-color': 'var(--muted-foreground)',
  '--w-rjv-type-string-color': 'var(--color-code-orange)',
  '--w-rjv-type-int-color': 'var(--color-code-number)',
  '--w-rjv-type-float-color': 'var(--color-code-number)',
  '--w-rjv-type-boolean-color': 'var(--color-code-keyword)',
  '--w-rjv-type-null-color': 'var(--color-code-keyword)',
  '--w-rjv-type-undefined-color': 'var(--muted-foreground)',
  '--w-rjv-curlybraces-color': 'var(--muted-foreground)',
  '--w-rjv-brackets-color': 'var(--muted-foreground)',
  '--w-rjv-colon-color': 'var(--muted-foreground)',
  '--w-rjv-ellipsis-color': 'var(--muted-foreground)',
  '--w-rjv-arrow-color': 'var(--muted-foreground)',
  '--w-rjv-line-color': 'var(--border)',
} as React.CSSProperties

/** A primitive matches when its stringified form contains the (lowercased) query. */
function matchesQuery(value: unknown, lowerQuery: string): boolean {
  return String(value).toLowerCase().includes(lowerQuery)
}

/** Filter an array: keep only elements whose filtered subtree is non-empty. */
function filterJsonArray(value: unknown[], query: string): unknown[] | undefined {
  const filtered = value
    .map((item) => filterJson(item, query))
    .filter((item) => item !== undefined)
  return filtered.length > 0 ? filtered : undefined
}

/**
 * Resolve one object entry: a key matching the query keeps the whole value
 * as-is; otherwise the value itself is filtered recursively.
 */
function filterJsonEntry(
  key: string,
  val: unknown,
  query: string,
  lowerQuery: string,
): { value: unknown; matched: boolean } {
  if (key.toLowerCase().includes(lowerQuery)) return { value: val, matched: true }
  const filteredVal = filterJson(val, query)
  return filteredVal !== undefined ? { value: filteredVal, matched: true } : { value: undefined, matched: false }
}

function filterJsonObject(
  value: Record<string, unknown>,
  query: string,
  lowerQuery: string,
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  let hasMatch = false
  for (const [key, val] of Object.entries(value)) {
    const entry = filterJsonEntry(key, val, query, lowerQuery)
    if (entry.matched) {
      result[key] = entry.value
      hasMatch = true
    }
  }
  return hasMatch ? result : undefined
}

/**
 * Filter a JSON value recursively, keeping only branches whose keys or
 * stringified primitive values contain the query (case-insensitive).
 *
 * Exported for unit testing; not part of the component's public API.
 */
export function filterJson(value: unknown, query: string): unknown {
  if (value === null || value === undefined) return undefined
  const lowerQuery = query.toLowerCase()
  if (Array.isArray(value)) return filterJsonArray(value, query)
  if (typeof value === 'object') return filterJsonObject(value as Record<string, unknown>, query, lowerQuery)
  return matchesQuery(value, lowerQuery) ? value : undefined
}

/**
 * Reusable JSON viewer component for workbench panels (AppData, Storage, etc.).
 *
 * Wraps `@uiw/react-json-view` with a dark theme consistent with the workbench
 * design system, optional search/filter, and path display on hover.
 */
export function JsonViewer({
  data,
  label,
  initialDepth = 2,
  searchable = true,
  showPath = true,
  className,
}: JsonViewerProps) {
  const [query, setQuery] = useState('')

  const displayData = useMemo(() => {
    if (!data) return {}
    if (!query.trim()) return data
    const result = filterJson(data, query.trim())
    return (result as Record<string, unknown>) ?? {}
  }, [data, query])

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    []
  )

  const isEmpty =
    displayData === null ||
    displayData === undefined ||
    (typeof displayData === 'object' && Object.keys(displayData as object).length === 0)

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', className)}>
      {/* Header bar with optional label and search */}
      {(label || searchable) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-2 py-1.5">
          {label && (
            <span className="select-none whitespace-nowrap text-xs font-medium text-foreground">
              {label}
            </span>
          )}
          {searchable && (
            <Input
              type="text"
              value={query}
              onChange={handleQueryChange}
              placeholder="Filter..."
              className="h-auto min-w-0 flex-1 bg-background px-1.5 py-0.5 font-mono text-xs"
            />
          )}
        </div>
      )}

      {/* JSON tree */}
      <div className="flex-1 overflow-auto p-1">
        {isEmpty ? (
          <div className="flex h-full select-none items-center justify-center text-xs text-muted-foreground">
            {query.trim() ? 'No matching results' : 'No data'}
          </div>
        ) : (
          <JsonView
            value={displayData as object}
            style={workbenchTheme}
            collapsed={initialDepth}
            displayDataTypes={false}
            displayObjectSize
            enableClipboard
            shortenTextAfterLength={120}
            {...(showPath ? { objectSortKeys: false } : {})}
          />
        )}
      </div>
    </div>
  )
}

export default JsonViewer
