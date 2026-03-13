import { EOT, DLE, FS, GS } from './constants.js'
import { Table } from './table.js'

/**
 * A group within a document. Can be accessed as a Table or iterated
 * for document-mode content.
 */
export class Group {
  readonly buf: Uint8Array
  private _start: number  // offset of the GS byte
  private _end: number    // offset past the last byte of this group

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf
    this._start = start
    this._end = end
  }

  /** Group name. */
  get name(): Uint8Array {
    let pos = this._start + 1 // skip GS
    const nameStart = pos
    while (pos < this._end && this.buf[pos] >= 0x20) pos++
    return this.buf.subarray(nameStart, pos)
  }

  /** Access as a Table (for tabular/key-value data). */
  get table(): Table {
    return new Table(this.buf, this._start)
  }

  /** Check if this group has an SOH header. */
  get hasHeader(): boolean {
    let pos = this._start + 1
    while (pos < this._end && this.buf[pos] >= 0x20) pos++
    return pos < this._end && this.buf[pos] === 0x01
  }

  /** Number of records. */
  get recordCount(): number {
    return this.table.recordCount
  }

  /** Raw bytes of this group. */
  get raw(): Uint8Array {
    return this.buf.subarray(this._start, this._end)
  }
}

/**
 * Zero-copy navigator for a full C0DATA document.
 *
 * Walks an entire buffer containing FS/GS/RS/US structure and provides
 * access to files, groups, records, and fields as slices into the
 * original buffer.
 */
export class Document {
  readonly buf: Uint8Array
  private _nameStart = 0
  private _nameEnd = 0
  private _groupOffsets: number[] = []
  private _groupNames: [number, number][] = []

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.index()
  }

  /** Document/file name (text after FS). Empty if no FS present. */
  get name(): Uint8Array {
    return this.buf.subarray(this._nameStart, this._nameEnd)
  }

  /** Number of top-level groups. */
  get groupCount(): number {
    return this._groupOffsets.length
  }

  /** Access a group by index. */
  group(i: number): Group
  /** Access a group by name. */
  group(name: string): Group
  group(key: number | string): Group {
    if (typeof key === 'number') return this.groupByIndex(key)
    return this.groupByName(key)
  }

  /** All group names. */
  get groupNames(): Uint8Array[] {
    return this._groupNames.map(([ns, ne]) => this.buf.subarray(ns, ne))
  }

  /** Iterate all groups. */
  eachGroup(cb: (group: Group) => void): void {
    for (let i = 0; i < this._groupOffsets.length; i++) {
      cb(this.groupByIndex(i))
    }
  }

  private groupByIndex(i: number): Group {
    const gsStart = this._groupOffsets[i]
    const gsEnd = i + 1 < this._groupOffsets.length
      ? this._groupOffsets[i + 1]
      : this.findEnd(gsStart)
    return new Group(this.buf, gsStart, gsEnd)
  }

  private groupByName(name: string): Group {
    const encoder = new TextEncoder()
    const target = encoder.encode(name)
    for (let i = 0; i < this._groupNames.length; i++) {
      const [ns, ne] = this._groupNames[i]
      const candidate = this.buf.subarray(ns, ne)
      if (candidate.length === target.length && candidate.every((b, j) => b === target[j])) {
        return this.groupByIndex(i)
      }
    }
    throw new Error(`No group named '${name}'`)
  }

  private index(): void {
    let pos = 0
    const len = this.buf.length

    // Skip FS + file name if present
    if (pos < len && this.buf[pos] === FS) {
      pos++
      this._nameStart = pos
      while (pos < len && this.buf[pos] >= 0x20) pos++
      this._nameEnd = pos
    }

    // Find all top-level GS groups
    while (pos < len) {
      const byte = this.buf[pos]
      if (byte === EOT) break

      if (byte === GS) {
        const gsPos = pos
        let gsCount = 0
        while (pos < len && this.buf[pos] === GS) {
          gsCount++
          pos++
        }

        if (gsCount === 1) {
          // Top-level group
          this._groupOffsets.push(gsPos)
          const nameStart = pos
          while (pos < len && this.buf[pos] >= 0x20) pos++
          this._groupNames.push([nameStart, pos])
        } else {
          // Deeper section (GS×N) — skip past its name
          while (pos < len && this.buf[pos] >= 0x20) pos++
        }
      } else {
        pos++
      }
    }
  }

  private findEnd(gsStart: number): number {
    let pos = gsStart
    const len = this.buf.length

    // Skip past the initial GS + name
    pos++
    while (pos < len && this.buf[pos] >= 0x20) pos++

    // Scan until next top-level GS, FS, or EOT
    while (pos < len) {
      const byte = this.buf[pos]
      if (byte === FS || byte === EOT) break

      if (byte === GS) {
        let count = 0
        let peek = pos
        while (peek < len && this.buf[peek] === GS) {
          count++
          peek++
        }
        if (count === 1) break // next top-level group
        pos = peek
        while (pos < len && this.buf[pos] >= 0x20) pos++
      } else if (byte === DLE) {
        pos += 2
      } else {
        pos++
      }
    }
    return pos
  }
}
