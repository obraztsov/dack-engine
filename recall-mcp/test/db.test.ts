import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  activityWindow,
  around,
  byTag,
  openDb,
  readEntry,
  recentActivity,
  relatedTags,
  renderThoughtLog,
  renderTranscript,
  search,
  tagNotes,
} from '../src/db'

/** Mirror of the Rust `SqliteRunLog` SCHEMA — for building a fixture DB the read-only `db.ts` then
 * queries. (The Rust side owns the schema in production; the B1 live-data migration + B4 dry-run prove
 * the two agree; this only exercises the query/render logic.) */
const SCHEMA = `
CREATE TABLE entries (rowid INTEGER PRIMARY KEY, run_id TEXT UNIQUE, stimulus_id TEXT, source TEXT,
  state TEXT, trust TEXT, outcome TEXT, ts INTEGER, day TEXT, context_summary TEXT,
  thought TEXT, sent TEXT, incoming TEXT, heading TEXT, safe_body TEXT);
CREATE TABLE entry_tags (run_id TEXT, tag TEXT, ts INTEGER, PRIMARY KEY(run_id, tag));
CREATE VIRTUAL TABLE entries_fts USING fts5(thought, sent, incoming, tokenize='porter unicode61');
CREATE TABLE tag_notes (id INTEGER PRIMARY KEY, kind TEXT, note TEXT, trust TEXT, ts INTEGER, delivered_at INTEGER);
CREATE TABLE note_tags (note_id INTEGER, tag TEXT, PRIMARY KEY(note_id, tag));
`

function fixture(): string {
  const path = `/tmp/recall-test-${process.pid}-${Date.now()}.sqlite`
  const d = new Database(path)
  d.run(SCHEMA)
  const ins = (rowid: number, run_id: string, ts: number, trust: string, thought: string, sent: string[], incoming: string, tags: string[]) => {
    d.run(
      `INSERT INTO entries (rowid, run_id, source, state, trust, outcome, ts, day, thought, sent, incoming, heading, safe_body)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rowid, run_id, 'telegram-pub', 'Perceive', trust, 'OK', ts, '2026-07-01', thought, JSON.stringify(sent), incoming, `## ${run_id}`, `## ${run_id}\n- thought: ${thought}`],
    )
    d.run(`INSERT INTO entries_fts (rowid, thought, sent, incoming) VALUES (?,?,?,?)`, [rowid, thought, sent.join(' '), incoming])
    for (const t of tags) d.run(`INSERT INTO entry_tags (run_id, tag, ts) VALUES (?,?,?)`, [run_id, t, ts])
  }
  // e1: thought has "quack"; incoming has "banana". tags chatX + telegram.
  ins(1, 'r1', 1000, 'public', 'the duck quacks', ['hi there'], '{"from_username":"al","text":"banana bread?"}', ['chatX', 'telegram'])
  // e2: same chat, later; also tag "trading".
  ins(2, 'r2', 2000, 'org', 'thinking about markets', ['sure'], '{"from_username":"al","text":"buy SOL?"}', ['chatX', 'telegram', 'trading'])
  // notes: a memory note + a pending digest note + a delivered digest note.
  d.run(`INSERT INTO tag_notes (id, kind, note, trust, ts, delivered_at) VALUES (1,'memory','al likes ducks','org',1500,NULL)`)
  d.run(`INSERT INTO note_tags (note_id, tag) VALUES (1,'chatX')`)
  d.run(`INSERT INTO tag_notes (id, kind, note, trust, ts, delivered_at) VALUES (2,'digest','summarize chatX','self',1600,NULL)`)
  d.run(`INSERT INTO note_tags (note_id, tag) VALUES (2,'telegram')`)
  d.run(`INSERT INTO tag_notes (id, kind, note, trust, ts, delivered_at) VALUES (3,'digest','old done item','self',1400,9999)`)
  d.run(`INSERT INTO note_tags (note_id, tag) VALUES (3,'telegram')`)
  d.close()
  return path
}

test('open is read-only (query_only blocks writes)', () => {
  const db = openDb(fixture())
  expect(() => db.run("INSERT INTO tag_notes(kind,note,trust,ts) VALUES ('x','y','z',1)")).toThrow()
})

test('byTag + time window', () => {
  const db = openDb(fixture())
  expect(byTag(db, 'chatX').map((r) => r.run_id)).toEqual(['r1', 'r2'])
  expect(byTag(db, 'chatX', 1500).map((r) => r.run_id)).toEqual(['r2']) // from_ts
  expect(byTag(db, 'trading').map((r) => r.run_id)).toEqual(['r2'])
})

test('activityWindow bounds the self feed by time (0 = open)', () => {
  const db = openDb(fixture())
  expect(activityWindow(db, 0, 0).map((r) => r.run_id)).toEqual(['r1', 'r2']) // fully open
  expect(activityWindow(db, 1500, 0).map((r) => r.run_id)).toEqual(['r2']) // from_ts
  expect(activityWindow(db, 0, 1500).map((r) => r.run_id)).toEqual(['r1']) // to_ts
})

test('recall_self_by_tag time-window (byTag from/to) — same as public, self view', () => {
  const db = openDb(fixture())
  expect(byTag(db, 'chatX', 1500, 0).map((r) => r.run_id)).toEqual(['r2'])
  expect(byTag(db, 'chatX', 0, 1500).map((r) => r.run_id)).toEqual(['r1'])
})

test('FTS trust boundary: self scope never matches raw incoming; raw scope only matches incoming', () => {
  const db = openDb(fixture())
  // {thought,sent} finds "quack", NOT the untrusted "banana"
  expect(search(db, 'quack', ['thought', 'sent'], 10).map((h) => h.run_id)).toEqual(['r1'])
  expect(search(db, 'banana', ['thought', 'sent'], 10)).toEqual([])
  // {incoming} is the only path to verbatim user text
  expect(search(db, 'banana', ['incoming'], 10).map((h) => h.run_id)).toEqual(['r1'])
  // full search sees everything
  expect(search(db, 'banana', ['thought', 'sent', 'incoming'], 10).length).toBe(1)
})

test('typed tag-notes: pending vs delivered, kind + tag filters', () => {
  const db = openDb(fixture())
  // default hides the delivered digest note
  const pending = tagNotes(db, {})
  expect(pending.map((n) => n.note).sort()).toEqual(['al likes ducks', 'summarize chatX'])
  // digest-only, pending
  expect(tagNotes(db, { kind: 'digest' }).map((n) => n.note)).toEqual(['summarize chatX'])
  // include expired shows the delivered one too
  expect(tagNotes(db, { kind: 'digest', includeExpired: true }).length).toBe(2)
  // by tag
  expect(tagNotes(db, { tag: 'chatX' }).map((n) => n.note)).toEqual(['al likes ducks'])
})

test('related_tags co-occurrence ranks by frequency', () => {
  const db = openDb(fixture())
  const rel = relatedTags(db, 'chatX', 10)
  expect(rel[0].tag).toBe('telegram') // co-occurs on both r1+r2
  expect(rel[0].count).toBe(2)
  expect(rel.map((r) => r.tag)).toContain('trading')
})

test('renderers honor the trust boundary', () => {
  const db = openDb(fixture())
  const rows = byTag(db, 'chatX')
  const thoughtLog = renderThoughtLog(rows)
  expect(thoughtLog).toContain('the duck quacks')
  expect(thoughtLog).not.toContain('banana') // self view never shows incoming
  const transcript = renderTranscript(rows)
  expect(transcript).toContain('banana bread?') // public view shows incoming
  expect(transcript).toContain('↳ you: hi there')
})

test('read_entry + recentActivity + around', () => {
  const db = openDb(fixture())
  expect(readEntry(db, 'r2')?.trust).toBe('org')
  expect(readEntry(db, 'nope')).toBeNull()
  expect(around(db, 1000, 1500).map((r) => r.run_id)).toEqual(['r1', 'r2']) // 1000±1500 covers both
  expect(around(db, 1000, 500).map((r) => r.run_id)).toEqual(['r1'])
})
