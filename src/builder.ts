import { SOH, STX, ETX, EOT, ENQ, DLE, SUB, FS, GS, RS, US } from './constants.js'

const encoder = new TextEncoder()

/**
 * Builds C0DATA documents in compact form.
 *
 * Example:
 *   const buf = build(b => {
 *     b.file('mydb', () => {
 *       b.group('users', ['name', 'amount', 'type'], () => {
 *         b.record('Alice', '1502.30', 'DEPOSIT')
 *         b.record('Bob', '340.00', 'WITHDRAWAL')
 *       })
 *     })
 *   })
 */
export class Builder {
  private parts: (number | Uint8Array)[] = []

  /** Write a file/database scope. */
  file(name: string, fn?: () => void): this {
    this.parts.push(FS)
    this.pushStr(name)
    fn?.()
    return this
  }

  /** Write a group/table scope with optional headers. */
  group(name: string, headers?: string[] | null, fn?: () => void): this {
    this.parts.push(GS)
    this.pushStr(name)
    if (headers) {
      this.parts.push(SOH)
      for (let i = 0; i < headers.length; i++) {
        if (i > 0) this.parts.push(US)
        this.pushStr(headers[i])
      }
    }
    fn?.()
    return this
  }

  /** Write a record with positional fields. */
  record(...fields: string[]): this {
    this.parts.push(RS)
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) this.parts.push(US)
      this.pushEscaped(fields[i])
    }
    return this
  }

  /** Write a record from an array of fields. */
  recordArray(fields: string[]): this {
    this.parts.push(RS)
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) this.parts.push(US)
      this.pushEscaped(fields[i])
    }
    return this
  }

  /** Write an EOT marker. */
  eot(): this {
    this.parts.push(EOT)
    return this
  }

  /** Write a nested sub-structure. */
  nested(fn: () => void): this {
    this.parts.push(STX)
    fn()
    this.parts.push(ETX)
    return this
  }

  /** Write a simple reference to a named group. */
  ref(...path: string[]): this {
    this.parts.push(ENQ)
    if (path.length === 1) {
      this.pushStr(path[0])
    } else {
      this.parts.push(STX)
      for (let i = 0; i < path.length; i++) {
        if (i > 0) this.parts.push(US)
        this.pushStr(path[i])
      }
      this.parts.push(ETX)
    }
    return this
  }

  /** Write a raw field value (for use within records when building fields individually). */
  field(value: string): this {
    this.parts.push(US)
    this.pushEscaped(value)
    return this
  }

  /** Write GS×N for document-mode depth. */
  section(name: string, depth: number = 1, fn?: () => void): this {
    for (let i = 0; i < depth; i++) this.parts.push(GS)
    this.pushStr(name)
    fn?.()
    return this
  }

  /** Write a content block (RS + text) for document mode. */
  block(text: string): this {
    this.parts.push(RS)
    this.pushEscaped(text)
    return this
  }

  /** Write a list item (US + text) for document mode. */
  item(text: string): this {
    this.parts.push(US)
    this.pushEscaped(text)
    return this
  }

  /** Finalize and return the buffer. */
  toUint8Array(): Uint8Array {
    // Calculate total size
    let size = 0
    for (const p of this.parts) {
      size += typeof p === 'number' ? 1 : p.length
    }

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
    // Check if escaping is needed
    let needsEscape = false
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] < 0x20) { needsEscape = true; break }
    }

    if (!needsEscape) {
      this.parts.push(bytes)
      return
    }

    // Slow path: escape control codes
    const escaped: number[] = []
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] < 0x20) escaped.push(DLE)
      escaped.push(bytes[i])
    }
    this.parts.push(new Uint8Array(escaped))
  }
}

/** Build a C0DATA buffer using the builder API. */
export function build(fn: (b: Builder) => void): Uint8Array {
  const b = new Builder()
  fn(b)
  return b.toUint8Array()
}
