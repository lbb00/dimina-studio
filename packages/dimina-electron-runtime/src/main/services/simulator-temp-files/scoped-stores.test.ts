import { describe, expect, it } from 'vitest'
import { ScopedTempStores } from './index.js'

describe('ScopedTempStores global FIFO', () => {
	it('caps two isolated scopes together, refreshes overwritten keys, and removes revoked entries from the ledger', () => {
		const stores = new ScopedTempStores()
		for (let i = 0; i < 101; i++) stores.write('a', `difile://_tmp/a-${i}`, 'text/plain', Buffer.from('a'))
		for (let i = 0; i < 100; i++) stores.write('b', `difile://_tmp/b-${i}`, 'text/plain', Buffer.from('b'))
		expect(stores.storeFor('a').has('difile://_tmp/a-0')).toBe(false)
		expect(stores.storeFor('b').has('difile://_tmp/b-0')).toBe(true)
		expect(stores.storeFor('a').size + stores.storeFor('b').size).toBe(200)
		stores.write('b', 'difile://_tmp/b-0', 'text/plain', Buffer.from('new'))
		expect(stores.storeFor('a').size + stores.storeFor('b').size).toBe(200)
		stores.revoke('b', 'difile://_tmp/b-0')
		stores.revokeAll('a')
		expect(stores.storeFor('a').size).toBe(0)
		expect(stores.storeFor('b').has('difile://_tmp/b-0')).toBe(false)
	})
})
