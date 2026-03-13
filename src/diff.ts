import { EOT, DLE, SUB, FS, GS, RS, US } from './constants.js'
import { C0Error } from './error.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** A single substitution: old text → new text. */
export interface Sub {
  readonly old: Uint8Array
  readonly new: Uint8Array
}

/** A pattern unit: either literal anchor text or a substitution. */
export type Unit = Uint8Array | Sub

function isSub(u: Unit): u is Sub {
  return typeof (u as Sub).old !== 'undefined'
}

/** A section is a sequential pattern of units (anchors + substitutions). */
export class Section {
  readonly units: Unit[]

  constructor(units: Unit[]) {
    this.units = units
  }

  /** Build the search pattern (old text concatenated). */
  searchPattern(): Uint8Array {
    const parts: number[] = []
    for (const unit of this.units) {
      if (isSub(unit)) {
        for (const b of unit.old) parts.push(b)
      } else {
        for (const b of unit) parts.push(b)
      }
    }
    return new Uint8Array(parts)
  }

  /** Build the replacement (new text concatenated). */
  replacement(): Uint8Array {
    const parts: number[] = []
    for (const unit of this.units) {
      if (isSub(unit)) {
        for (const b of unit.new) parts.push(b)
      } else {
        for (const b of unit) parts.push(b)
      }
    }
    return new Uint8Array(parts)
  }
}

/** A file edit: a file path and its sections. */
export interface FileEdit {
  readonly path: Uint8Array
  readonly sections: Section[]
}

/** Parse a C0DIFF buffer into a list of file edits. */
export function parseDiff(buf: Uint8Array): FileEdit[] {
  const edits: FileEdit[] = []
  let pos = 0
  const len = buf.length

  while (pos < len) {
    if (buf[pos] === EOT) break

    if (buf[pos] === FS) {
      pos++
      const [edit, newPos] = parseFileAt(buf, pos)
      edits.push(edit)
      pos = newPos
    } else {
      pos++
    }
  }

  return edits
}

/**
 * Apply a C0DIFF buffer to a map of file contents.
 * Returns the modified file contents. Raises on validation failure.
 * All files are validated before any modifications (atomic semantics).
 */
export function applyDiff(
  diffBuf: Uint8Array,
  files: Map<string, string> | Record<string, string>
): Map<string, string> {
  const fileMap = files instanceof Map ? files : new Map(Object.entries(files))
  const edits = parseDiff(diffBuf)
  const results = new Map<string, string>()

  // Validate all edits first
  for (const edit of edits) {
    const path = decoder.decode(edit.path)
    const content = fileMap.get(path)
    if (content === undefined) throw new C0Error(`File not found: ${path}`)

    for (let i = 0; i < edit.sections.length; i++) {
      const pattern = decoder.decode(edit.sections[i].searchPattern())
      const count = countOccurrences(content, pattern)
      if (count === 0) {
        throw new C0Error(`Pattern not found in ${path} (section ${i}): ${JSON.stringify(pattern)}`)
      } else if (count > 1) {
        throw new C0Error(`Pattern found ${count} times in ${path} (section ${i}), expected exactly 1: ${JSON.stringify(pattern)}`)
      }
    }
  }

  // Apply all edits
  for (const edit of edits) {
    const path = decoder.decode(edit.path)
    let content = fileMap.get(path)!

    for (const section of edit.sections) {
      const pattern = decoder.decode(section.searchPattern())
      const replacement = decoder.decode(section.replacement())
      content = content.replace(pattern, replacement)
    }

    results.set(path, content)
  }

  // Include unmodified files
  for (const [path, content] of fileMap) {
    if (!results.has(path)) results.set(path, content)
  }

  return results
}

/** Build a C0DIFF document. */
export function buildDiff(fn: (b: DiffBuilder) => void): Uint8Array {
  const b = new DiffBuilder()
  fn(b)
  return b.toUint8Array()
}

// --- Internals ---

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count++
    pos = idx + needle.length
  }
  return count
}

function parseFileAt(buf: Uint8Array, pos: number): [FileEdit, number] {
  const len = buf.length

  // Read file path
  const pathStart = pos
  while (pos < len && buf[pos] >= 0x20) pos++
  const path = buf.slice(pathStart, pos)

  // Read sections
  const sections: Section[] = []
  while (pos < len) {
    if (buf[pos] === FS || buf[pos] === EOT) break

    if (buf[pos] === GS) {
      pos++
      const [units, newPos] = parseSectionAt(buf, pos)
      sections.push(new Section(units))
      pos = newPos
    } else {
      pos++
    }
  }

  return [{ path, sections }, pos]
}

function parseSectionAt(buf: Uint8Array, pos: number): [Unit[], number] {
  const units: Unit[] = []
  const len = buf.length
  let inSub = false
  let dataStart = pos

  while (pos < len) {
    const byte = buf[pos]
    if (byte === GS || byte === FS || byte === EOT) break

    if (byte === US) {
      if (pos > dataStart) {
        const span = collectData(buf, dataStart, pos)
        if (inSub) {
          const old = units.pop() as Uint8Array
          units.push({ old, new: span })
          inSub = false
        } else {
          units.push(span)
        }
      }
      pos++
      dataStart = pos
    } else if (byte === SUB) {
      if (pos > dataStart) {
        const span = collectData(buf, dataStart, pos)
        units.push(span)
        inSub = true
      }
      pos++
      dataStart = pos
    } else if (byte === DLE) {
      pos += 2
    } else {
      pos++
    }
  }

  // Handle trailing data
  if (pos > dataStart) {
    const span = collectData(buf, dataStart, pos)
    if (inSub) {
      const old = units.pop() as Uint8Array
      units.push({ old, new: span })
    } else {
      units.push(span)
    }
  }

  return [units, pos]
}

function collectData(buf: Uint8Array, start: number, stop: number): Uint8Array {
  // Fast path: no DLE
  let hasDLE = false
  for (let i = start; i < stop; i++) {
    if (buf[i] === DLE) { hasDLE = true; break }
  }
  if (!hasDLE) return buf.slice(start, stop)

  // Slow path: unescape
  const out: number[] = []
  let pos = start
  while (pos < stop) {
    if (buf[pos] === DLE) {
      pos++
      if (pos < stop) out.push(buf[pos])
      pos++
    } else {
      out.push(buf[pos])
      pos++
    }
  }
  return new Uint8Array(out)
}

// --- Builders ---

export class DiffBuilder {
  private parts: (number | Uint8Array)[] = []

  file(path: string, fn: () => void): this {
    this.parts.push(FS)
    this.pushStr(path)
    fn()
    return this
  }

  section(fn: (sb: SectionBuilder) => void): this {
    this.parts.push(GS)
    const sb = new SectionBuilder(this.parts)
    fn(sb)
    return this
  }

  replace(contextBefore: string, oldText: string, newText: string, contextAfter: string = ''): this {
    this.parts.push(GS)
    if (contextBefore) {
      this.pushEscaped(contextBefore)
      this.parts.push(US)
    }
    this.pushEscaped(oldText)
    this.parts.push(SUB)
    this.pushEscaped(newText)
    if (contextAfter) {
      this.parts.push(US)
      this.pushEscaped(contextAfter)
    }
    return this
  }

  toUint8Array(): Uint8Array {
    let size = 0
    for (const p of this.parts) size += typeof p === 'number' ? 1 : p.length
    const out = new Uint8Array(size)
    let offset = 0
    for (const p of this.parts) {
      if (typeof p === 'number') {
        out[offset++] = p
      } else {
        out.set(p, offset)
        offset += p.length
      }
    }
    return out
  }

  private pushStr(s: string): void {
    this.parts.push(encoder.encode(s))
  }

  private pushEscaped(s: string): void {
    const bytes = encoder.encode(s)
    let needsEscape = false
    for (const b of bytes) {
      if (b < 0x20) { needsEscape = true; break }
    }
    if (!needsEscape) {
      this.parts.push(bytes)
      return
    }
    const escaped: number[] = []
    for (const b of bytes) {
      if (b < 0x20) escaped.push(DLE)
      escaped.push(b)
    }
    this.parts.push(new Uint8Array(escaped))
  }
}

export class SectionBuilder {
  private parts: (number | Uint8Array)[]
  private first = true

  constructor(parts: (number | Uint8Array)[]) {
    this.parts = parts
  }

  anchor(text: string): this {
    if (!this.first) this.parts.push(US)
    this.pushEscaped(text)
    this.first = false
    return this
  }

  sub(oldText: string, newText: string): this {
    if (!this.first) this.parts.push(US)
    this.pushEscaped(oldText)
    this.parts.push(SUB)
    this.pushEscaped(newText)
    this.first = false
    return this
  }

  private pushEscaped(s: string): void {
    const bytes = encoder.encode(s)
    let needsEscape = false
    for (const b of bytes) {
      if (b < 0x20) { needsEscape = true; break }
    }
    if (!needsEscape) {
      this.parts.push(bytes)
      return
    }
    const escaped: number[] = []
    for (const b of bytes) {
      if (b < 0x20) escaped.push(DLE)
      escaped.push(b)
    }
    this.parts.push(new Uint8Array(escaped))
  }
}
