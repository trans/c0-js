import { DLE, ETB, EOT, ASSIGNED } from './constants.js'
import { UnexpectedEndError } from './error.js'

/**
 * Decode DLE escapes, returning the logical bytes of a value.
 * Zero-copy (returns the input slice) when no escapes are present.
 */
export function unescape(buf: Uint8Array): Uint8Array {
  let i = 0
  const len = buf.length
  while (i < len) {
    if (buf[i] === DLE) return unescapeSlow(buf, i)
    i++
  }
  return buf
}

function unescapeSlow(buf: Uint8Array, first: number): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < first; i++) out.push(buf[i])
  let i = first
  const len = buf.length
  while (i < len) {
    if (buf[i] === DLE) {
      i++
      if (i >= len) throw new UnexpectedEndError()
      out.push(buf[i])
    } else {
      out.push(buf[i])
    }
    i++
  }
  return new Uint8Array(out)
}

/**
 * Whether bytes are a canonical document unit for content addressing
 * (see DESIGN.md "Canonical Form" in c0-cr): well-formed, minimally
 * escaped (DLE appears only before bytes < 0x20), and free of framing
 * bytes (ETB, EOT). Stream logs validate per-block, not with this.
 */
export function canonical(buf: Uint8Array): boolean {
  let i = 0
  const len = buf.length
  while (i < len) {
    const byte = buf[i]
    if (byte === DLE) {
      if (i + 1 >= len) return false       // dangling escape
      if (buf[i + 1] >= 0x20) return false // gratuitous escape
      i += 2
    } else if (byte === ETB || byte === EOT) {
      return false                         // framing in a document unit
    } else if (byte < 0x20) {
      if (!ASSIGNED.has(byte)) return false // unassigned code
      i++
    } else {
      i++
    }
  }
  return true
}
