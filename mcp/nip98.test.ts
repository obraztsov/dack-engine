import { test, expect } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { parseSecretKey, pubkeyOf, signEvent, nip98Event, nip98Header, schnorrVerify } from './nip98'

test('BIP-340 vector 0: the pubkey derivation matches the reference', () => {
  // https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv (index 0)
  const sk = parseSecretKey('0000000000000000000000000000000000000000000000000000000000000003')
  expect(pubkeyOf(sk)).toBe('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')
})

test('a signed event has a NIP-01 id over the canonical form and a verifying schnorr sig', () => {
  const sk = parseSecretKey('11'.repeat(32))
  const ev = signEvent(sk, { kind: 1, created_at: 1700000000, tags: [['t', 'x']], content: 'hi' })
  const ser = JSON.stringify([0, ev.pubkey, 1700000000, 1, [['t', 'x']], 'hi'])
  expect(ev.id).toBe(Buffer.from(sha256(new TextEncoder().encode(ser))).toString('hex'))
  expect(schnorrVerify(ev.sig, Buffer.from(ev.id, 'hex'), ev.pubkey)).toBe(true)
  expect(schnorrVerify(ev.sig, Buffer.from('00'.repeat(32), 'hex'), ev.pubkey)).toBe(false)
})

test('the NIP-98 event carries u / method / nonce (+ payload hash) and renders a Nostr header', () => {
  const sk = parseSecretKey('22'.repeat(32))
  const u = 'https://relay.example/git/abcd/repo'
  const ev = nip98Event(sk, u, 'post', { payload: new TextEncoder().encode('body'), now: 1700000000, nonce: 'n-1' })
  expect(ev.kind).toBe(27235)
  expect(ev.tags).toEqual([['u', u], ['method', 'POST'], ['nonce', 'n-1'], ['payload', Buffer.from(sha256(new TextEncoder().encode('body'))).toString('hex')]])
  const h = nip98Header(ev)
  expect(h.startsWith('Nostr ')).toBe(true)
  expect(JSON.parse(Buffer.from(h.slice(6), 'base64').toString()).id).toBe(ev.id)
  // a fresh nonce every time by default
  expect(nip98Event(sk, u, 'GET').tags[2][1]).not.toBe(nip98Event(sk, u, 'GET').tags[2][1])
})

test('a malformed key is refused', () => {
  expect(() => parseSecretKey('nsec1abc')).toThrow()
  expect(() => parseSecretKey('zz'.repeat(32))).toThrow()
})
