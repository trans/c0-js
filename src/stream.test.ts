import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RS, US, DLE, ETB } from './constants.js'
import { tokenize } from './tokenizer.js'
import { TokenType } from './token.js'
import { Table } from './table.js'
import { format, parse } from './pretty.js'
import { StreamReader, openLog, readLog } from './stream.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function buf(...parts: (number | string)[]): Uint8Array {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'number') out.push(p)
    else for (const b of encoder.encode(p)) out.push(b)
  }
  return new Uint8Array(out)
}

describe('Stream', () => {
  describe('tokenizer', () => {
    it('emits ETB tokens', () => {
      const tokens = tokenize(buf(RS, 'create', US, 'a1b2', ETB))
      assert.deepEqual(tokens.map(t => t.type), [
        TokenType.RS, TokenType.Data, TokenType.US, TokenType.Data, TokenType.ETB,
      ])
    })

    it('treats DLE-escaped ETB as data', () => {
      const tokens = tokenize(buf(RS, DLE, ETB))
      assert.deepEqual(tokens.map(t => t.type), [TokenType.RS, TokenType.Data])
    })
  })

  describe('table tolerance', () => {
    it('parses an ETB-committed log the same as an uncommitted one', () => {
      const bytes = buf(0x1d, 'claims', ETB, 0x01, 'op', US, 'arg', ETB,
        RS, 'create', US, 'a1b2', ETB, RS, 'name', US, 'draft', ETB)
      const t = new Table(bytes)
      assert.equal(decoder.decode(t.name), 'claims')
      assert.deepEqual(t.headers.map(h => decoder.decode(h)), ['op', 'arg'])
      assert.equal(t.recordCount, 2)
      assert.deepEqual(t.record(0).fields.map(f => decoder.decode(f)), ['create', 'a1b2'])
    })
  })

  describe('pretty form', () => {
    it('renders ETB as ␗ on the record line and round-trips', () => {
      const bytes = buf(RS, 'create', US, 'a1b2', ETB, RS, 'name', US, 'draft', ETB)
      const pretty = format(bytes)
      assert.ok(pretty.includes('␞create␟a1b2␗'))
      assert.deepEqual(parse(pretty), bytes)
    })
  })

  describe('StreamReader', () => {
    it('reads committed records and skips a torn tail', () => {
      const bytes = buf(RS, 'create', US, 'a1b2', ETB, RS, 'name', US, 'dra')
      const reader = new StreamReader(bytes)
      assert.equal(reader.torn, true)
      assert.equal(reader.blockCount, 1)
      assert.equal(decoder.decode(reader.tail), 'namedra')
      assert.equal(reader.table.recordCount, 1)
    })

    it('commits a multi-record batch as one block', () => {
      const reader = new StreamReader(buf(RS, 'a', RS, 'b', ETB))
      assert.equal(reader.blockCount, 1)
      assert.equal(reader.table.recordCount, 2)
    })
  })

  describe('openLog', () => {
    it('appends committed records and repairs a torn tail', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'c0stream-'))
      const path = join(dir, 'claims.c0')
      try {
        let log = await openLog(path)
        log.header('op', 'arg')
        log.record('create', 'a1b2')
        log.close()

        // Simulate a crash mid-append (tear ends in a bare DLE)
        appendFileSync(path, Buffer.from([RS, 0x78, DLE]))
        assert.equal(new StreamReader(readFileSync(path)).torn, true)

        log = await openLog(path)
        log.record('tag', 'alpha')
        log.close()

        const reader = await readLog(path)
        assert.equal(reader.torn, false)
        assert.equal(reader.blockCount, 3)
        const t = reader.table
        assert.deepEqual(t.headers.map(h => decoder.decode(h)), ['op', 'arg'])
        assert.equal(t.recordCount, 2)
        assert.equal(decoder.decode(t.record(1).field(0)), 'tag')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('writes an atomic batch under one commit', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'c0stream-'))
      const path = join(dir, 'batch.c0')
      try {
        const log = await openLog(path)
        log.batch(b => {
          b.record('name', 'draft')
          b.record('tag', 'alpha')
        })
        log.close()

        const reader = await readLog(path)
        assert.equal(reader.blockCount, 1)
        assert.equal(reader.table.recordCount, 2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
