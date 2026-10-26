import { describe, expect, it } from 'vitest'
import {
  makeInitialShellState,
  parseUrl,
  reduceNavigateTo,
  type PageEntry,
} from './page-stack-controller.js'
import { makeDefaultNavigationBarState } from './navigation-bar.js'

/** A query value may itself contain '?'; only the first '?' starts the query. */
const ROUTE_WITH_QUERY_QUESTION = 'pages/index/index?url=https://a.com?x=1'

function entryFromRoute(url: string, bridgeId: string): PageEntry {
  const { pagePath, query } = parseUrl(url)
  return {
    bridgeId,
    pagePath,
    query,
    isTab: false,
    windowConfig: {},
    navBar: makeDefaultNavigationBarState({
      title: pagePath,
      backgroundColor: '#ffffff',
      textStyle: 'black',
      style: 'default',
      homeButtonVisible: false,
    }),
  }
}

describe('parseUrl — query value containing ?', () => {
  it('keeps the full query, including a second navigation that parses the same shape', () => {
    const home = entryFromRoute('pages/home/index', 'home')
    const first = entryFromRoute(ROUTE_WITH_QUERY_QUESTION, 'first')
    const second = entryFromRoute(ROUTE_WITH_QUERY_QUESTION, 'second')

    expect(first.pagePath).toBe('pages/index/index')
    expect(first.query).toEqual({ url: 'https://a.com?x=1' })
    expect(second.query).toEqual({ url: 'https://a.com?x=1' })

    const afterFirst = reduceNavigateTo(makeInitialShellState(home), first)
    expect(afterFirst.next.stack.map((entry) => entry.query)).toEqual([
      {},
      { url: 'https://a.com?x=1' },
    ])

    const afterSecond = reduceNavigateTo(afterFirst.next, second)
    expect(afterSecond.next.stack.map((entry) => entry.query)).toEqual([
      {},
      { url: 'https://a.com?x=1' },
      { url: 'https://a.com?x=1' },
    ])
  })

  it('decodes + in a preserved tail as a space and still navigates when a % escape is invalid', () => {
    const plus = parseUrl('pages/index/index?url=https://a.com?q=a+b')
    expect(plus).toEqual({
      pagePath: 'pages/index/index',
      query: { url: 'https://a.com?q=a b' },
    })

    const broken = parseUrl('pages/index/index?url=https://a.com?q=100%')
    expect(broken.pagePath).toBe('pages/index/index')
    expect(broken.query).toEqual({ url: 'https://a.com?q=100%' })

    const home = entryFromRoute('pages/home/index', 'home')
    const after = reduceNavigateTo(makeInitialShellState(home), entryFromRoute('pages/index/index?q=%ZZ', 'broken'))
    expect(after.next.stack[1]?.query).toEqual({ q: '%ZZ' })
  })
})
