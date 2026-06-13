import { DLE, ETB, STX, ETX } from './constants.js'
import { Table, Record } from './table.js'
import { Builder } from './builder.js'

/**
 * Stream mode: ETB commits for append-only logs.
 *
 * C0DATA records are start-delimited, so a crashed append leaves a
 * truncated final record indistinguishable from a complete one. In
 * stream mode every appended block (one or more records, or an SOH
 * header) is terminated by an ETB commit marker. A block is complete
 * if and only if it is terminated by ETB.
 */

/**
 * Scans a buffer for ETB commit markers and exposes only the
 * committed region. Zero-copy: accessors return subarrays.
 *
 *   const reader = new StreamReader(buf)
 *   reader.torn                       // uncommitted tail present?
 *   reader.eachRecord(rec => { ... }) // committed records only
 */
export class StreamReader {
  readonly buf: Uint8Array
  private commits: [number, number][] = [] // [etb offset, end of payload]

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.scan()
  }

  /** Offset just past the last commit marker and its payload. */
  get committedEnd(): number {
    return this.commits.length === 0 ? 0 : this.commits[this.commits.length - 1][1]
  }

  /** The committed region of the buffer. */
  get committed(): Uint8Array {
    return this.buf.subarray(0, this.committedEnd)
  }

  /** Uncommitted trailing bytes — residue of an interrupted append. */
  get tail(): Uint8Array {
    return this.buf.subarray(this.committedEnd)
  }

  /** True if uncommitted bytes trail the last commit marker. */
  get torn(): boolean {
    return this.committedEnd < this.buf.length
  }

  /** Number of committed blocks. */
  get blockCount(): number {
    return this.commits.length
  }

  /**
   * Committed block by index: the bytes between the previous commit
   * and this block's ETB (marker and payload excluded).
   */
  block(i: number): Uint8Array {
    const start = i === 0 ? 0 : this.commits[i - 1][1]
    return this.buf.subarray(start, this.commits[i][0])
  }

  /** Iterate committed blocks. */
  eachBlock(cb: (block: Uint8Array) => void): void {
    for (let i = 0; i < this.commits.length; i++) cb(this.block(i))
  }

  /**
   * The committed region as a Table (handles an optional GS name and
   * SOH header, then RS records).
   */
  get table(): Table {
    return new Table(this.committed)
  }

  /** Iterate committed records. */
  eachRecord(cb: (rec: Record) => void): void {
    this.table.eachRecord(cb)
  }

  // Find every ETB at structural level: DLE-escaped bytes are data,
  // and ETB inside an STX/ETX scope is record content, not a commit.
  private scan(): void {
    let pos = 0
    const len = this.buf.length

    while (pos < len) {
      const byte = this.buf[pos]
      if (byte === DLE) {
        pos += 2
      } else if (byte === STX) {
        pos = skipNested(this.buf, pos, len)
      } else if (byte === ETB) {
        const etbPos = pos
        pos++
        // Payload runs until the next control code
        while (pos < len && this.buf[pos] >= 0x20) pos++
        this.commits.push([etbPos, pos])
      } else {
        pos++
      }
    }
  }
}

function skipNested(buf: Uint8Array, pos: number, stop: number): number {
  pos++ // skip STX
  let depth = 1
  while (pos < stop && depth > 0) {
    const byte = buf[pos]
    if (byte === STX) depth++
    else if (byte === ETX) depth--
    else if (byte === DLE) pos++
    pos++
  }
  return pos
}

/** Destination for committed blocks (e.g. a file or socket). */
export interface StreamSink {
  /** Write one committed block (block bytes + ETB) as a single unit. */
  write(bytes: Uint8Array): void
  /** Optional durability barrier (e.g. fsync), called after each commit. */
  sync?(): void
}

/**
 * Appends ETB-committed blocks to an append-only log.
 *
 *   const log = new StreamWriter(sink)
 *   log.record('create', nonce, ts)
 *   log.batch(b => {                  // atomic multi-record commit
 *     b.record('name', label, ts)
 *     b.record('tag', tag, ts)
 *   })
 *
 * Each block and its ETB are issued as a single write. When appending
 * to an existing log, repair the tail first (see `openLog`) — blind
 * appends after a torn tail are unsafe (a tail ending in a bare DLE
 * would escape the next append's RS and fuse two records).
 */
export class StreamWriter {
  private sink: StreamSink

  constructor(sink: StreamSink) {
    this.sink = sink
  }

  /** Append one record as a committed block. */
  record(...fields: string[]): void {
    this.commit(b => { b.recordArray(fields) })
  }

  /** Append one record from an array of fields. */
  recordArray(fields: string[]): void {
    this.commit(b => { b.recordArray(fields) })
  }

  /** Append an SOH header as a committed block. */
  header(...names: string[]): void {
    this.commit(b => { b.header(names) })
  }

  /** Append a group preamble (GS + name) as a committed block. */
  group(name: string, headers?: string[] | null): void {
    this.commit(b => { b.group(name, headers) })
  }

  /**
   * Append several records under a single commit. The batch is
   * atomic: a tear anywhere inside it discards the whole block.
   */
  batch(fn: (b: Builder) => void): void {
    this.commit(fn)
  }

  private commit(fn: (b: Builder) => void): void {
    const b = new Builder()
    fn(b)
    b.etb()
    this.sink.write(b.toUint8Array())
    this.sink.sync?.()
  }
}

/** A StreamWriter over a log file. Close when done. */
export interface FileLog extends StreamWriter {
  close(): void
}

/**
 * Open an append-only log file (Node only), repairing any torn tail
 * first by truncating to the last commit marker. With `sync: true`
 * (the default) every commit is fsync'd.
 */
export async function openLog(path: string, opts?: { sync?: boolean }): Promise<FileLog> {
  const fs = await import('node:fs')

  // Repair: truncate an uncommitted tail so the log ends at a commit
  if (fs.existsSync(path)) {
    const reader = new StreamReader(fs.readFileSync(path))
    if (reader.torn) {
      fs.truncateSync(path, reader.committedEnd)
    }
  }

  const fd = fs.openSync(path, 'a')
  const wantSync = opts?.sync ?? true
  const writer = new StreamWriter({
    write: bytes => { fs.writeSync(fd, bytes) },
    sync: wantSync ? () => { fs.fsyncSync(fd) } : undefined,
  }) as FileLog
  writer.close = () => { fs.closeSync(fd) }
  return writer
}

/** Read a log file (Node only) into a StreamReader. */
export async function readLog(path: string): Promise<StreamReader> {
  const fs = await import('node:fs')
  return new StreamReader(fs.readFileSync(path))
}
