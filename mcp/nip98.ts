/**
 * NIP-98 HTTP auth for the Buzz relay's git smart-HTTP (and `/query`), signed in-process with the duck's
 * Buzz key — the key never touches argv or disk; git only ever sees one `Authorization` header value.
 *
 * Jarvis (Hermes) reverse-engineered the relay's rules on 2026-10-12: kind 27235; tags `u` = the REPO BASE
 * URL (`<relay>/git/<owner>/<repo>`, NOT the request URL — signing the request URL yields "NIP-98 auth
 * failed" forever), `method`, a `nonce` (uuid4, REQUIRED by this relay), optional `payload` (sha256 of the
 * body). Header: `Authorization: Nostr <base64(event json)>`. Pure functions; the signer is checked against
 * BIP-340 test vector 0 in nip98.test.ts.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

export type NostrEvent = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))

/** Accept a 64-hex secret key (the harness materializes BUZZ_PRIVATE_KEY as hex; nsec is not handled here). */
export function parseSecretKey(raw: string): Uint8Array {
  const k = raw.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('BUZZ_PRIVATE_KEY must be 64 hex chars')
  return fromHex(k.toLowerCase())
}

export const pubkeyOf = (sk: Uint8Array): string => hex(schnorr.getPublicKey(sk))

/** NIP-01: id = sha256 of the canonical serialization; sig = BIP-340 schnorr over the id. */
export function signEvent(sk: Uint8Array, ev: { kind: number; created_at: number; tags: string[][]; content: string }): NostrEvent {
  const pubkey = pubkeyOf(sk)
  const ser = JSON.stringify([0, pubkey, ev.created_at, ev.kind, ev.tags, ev.content])
  const id = sha256(new TextEncoder().encode(ser))
  const sig = schnorr.sign(id, sk)
  return { id: hex(id), pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: hex(sig) }
}

/** The NIP-98 event for one request. `u` is whatever the relay wants signed (the repo BASE url for git). */
export function nip98Event(sk: Uint8Array, u: string, method: string, opts: { payload?: Uint8Array; now?: number; nonce?: string } = {}): NostrEvent {
  const tags: string[][] = [['u', u], ['method', method.toUpperCase()], ['nonce', opts.nonce ?? crypto.randomUUID()]]
  if (opts.payload) tags.push(['payload', hex(sha256(opts.payload))])
  return signEvent(sk, { kind: 27235, created_at: opts.now ?? Math.floor(Date.now() / 1000), tags, content: '' })
}

/** `Authorization` header value: `Nostr <base64(event)>`. */
export function nip98Header(ev: NostrEvent): string {
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`
}

export const schnorrVerify = (sig: string, msg: Uint8Array, pubkey: string): boolean => schnorr.verify(fromHex(sig), msg, fromHex(pubkey))
