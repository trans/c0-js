import { SOH, STX, ETX, EOT, ENQ, DLE, ETB, SUB, FS, GS, RS, US } from './constants.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Convert a C0 control byte to its Unicode Control Picture character. */
export function glyph(byte: number): string {
  return String.fromCodePoint(0x2400 + byte)
}

export type FormatMode = 'compact' | 'aligned' | 'spaced'

export interface FormatOptions {
  indent?: string
  mode?: FormatMode
}

/**
 * Format a compact C0DATA buffer as a human-readable Unicode string
 * with newlines and indentation.
 *
 * Modes:
 * - `'compact'` — no padding between fields (default)
 * - `'aligned'` — column-aligned fields within table groups
 * - `'spaced'`  — column-aligned + space after prefix glyphs and around ␟
 */
export function format(buf: Uint8Array, options?: string | FormatOptions): string {
  let indent = '  '
  let mode: FormatMode = 'compact'

  if (typeof options === 'string') {
    indent = options
  } else if (options) {
    indent = options.indent ?? '  '
    mode = options.mode ?? 'compact'
  }

  const pretty = formatCompact(buf, indent)
  if (mode === 'compact') return pretty
  return align(pretty, mode)
}

function formatCompact(buf: Uint8Array, indent: string): string {
  const parts: string[] = []
  let pos = 0
  const len = buf.length
  let depth = 0
  let lineStart = true

  while (pos < len) {
    const byte = buf[pos]

    if (byte < 0x20) {
      switch (byte) {
        case FS:
          depth = 0
          if (!lineStart) parts.push('\n')
          parts.push(glyph(byte))
          pos++
          depth = 1
          pos = writeDataUntilControl(buf, pos, parts)
          parts.push('\n')
          lineStart = true
          break

        case GS: {
          let gsRun = 0
          while (pos < len && buf[pos] === GS) {
            gsRun++
            pos++
          }
          if (!lineStart) parts.push('\n')
          writeIndent(parts, indent, depth)
          for (let i = 0; i < gsRun; i++) parts.push(glyph(GS))
          pos = writeDataUntilControl(buf, pos, parts)
          parts.push('\n')
          lineStart = true
          break
        }

        case SOH:
          writeIndent(parts, indent, depth + 1)
          parts.push(glyph(byte))
          pos++
          pos = writeFieldsLine(buf, pos, parts)
          parts.push('\n')
          lineStart = true
          break

        case RS:
          writeIndent(parts, indent, depth + 1)
          parts.push(glyph(byte))
          pos++
          pos = writeFieldsLine(buf, pos, parts)
          parts.push('\n')
          lineStart = true
          break

        case STX:
          parts.push(glyph(byte))
          pos++
          depth++
          parts.push('\n')
          lineStart = true
          break

        case ETX:
          if (depth > 0) depth--
          writeIndent(parts, indent, depth + 1)
          parts.push(glyph(byte))
          pos++
          break

        case EOT:
          if (!lineStart) parts.push('\n')
          parts.push(glyph(byte))
          parts.push('\n')
          pos++
          lineStart = true
          break

        case ENQ:
          parts.push(glyph(byte))
          pos++
          break

        case DLE:
          parts.push(glyph(byte))
          pos++
          if (pos < len) {
            if (buf[pos] < 0x20) parts.push(glyph(buf[pos]))
            else parts.push(String.fromCharCode(buf[pos]))
            pos++
          }
          break

        case SUB:
          parts.push(glyph(byte))
          pos++
          break

        case US:
          parts.push(glyph(byte))
          pos++
          break

        case ETB:
          // Commit marker not attached to a record line (e.g. after a
          // group-name line). Indented on its own line with any payload.
          if (lineStart) writeIndent(parts, indent, depth + 1)
          parts.push(glyph(byte))
          pos++
          pos = writeDataUntilControl(buf, pos, parts)
          parts.push('\n')
          lineStart = true
          break

        default:
          parts.push(glyph(byte))
          pos++
          break
      }
    } else {
      // Data byte
      parts.push(String.fromCharCode(byte))
      pos++
      lineStart = false
    }
  }
  if (!lineStart) parts.push('\n')
  return parts.join('')
}

/**
 * Parse pretty-form back to compact form.
 *
 * Rules:
 * - Unicode Control Pictures (U+2400-U+241F) → C0 bytes
 * - LF/CR are ignored (formatting only)
 * - Whitespace adjacent to control codes is trimmed
 * - Inside STX/ETX, everything is preserved verbatim
 */
export function parse(str: string): Uint8Array {
  const out: number[] = []
  const wsBuf: number[] = []
  let trimAfter = true
  let i = 0

  while (i < str.length) {
    const cp = str.codePointAt(i)!
    const charLen = cp > 0xffff ? 2 : 1

    if (cp >= 0x2400 && cp <= 0x241f) {
      const code = cp - 0x2400
      // Discard buffered whitespace
      wsBuf.length = 0

      if (code === STX) {
        out.push(code)
        i += charLen
        // Inside STX/ETX: preserve everything verbatim
        i = parseQuoted(str, i, out)
      } else {
        out.push(code)
        i += charLen
      }
      trimAfter = true
    } else if (cp === 0x0a || cp === 0x0d) {
      // LF/CR ignored, discard buffered whitespace
      wsBuf.length = 0
      trimAfter = true
      i += charLen
    } else if (cp === 0x20 || cp === 0x09) {
      if (trimAfter) {
        i += charLen
        continue
      }
      // Buffer whitespace
      wsBuf.push(cp)
      i += charLen
    } else {
      trimAfter = false
      // Flush buffered whitespace
      if (wsBuf.length > 0) {
        for (const ws of wsBuf) out.push(ws)
        wsBuf.length = 0
      }
      // Write UTF-8 bytes
      const bytes = encoder.encode(String.fromCodePoint(cp))
      for (const b of bytes) out.push(b)
      i += charLen
    }
  }

  return new Uint8Array(out)
}

function parseQuoted(str: string, i: number, out: number[]): number {
  let depth = 1

  while (i < str.length) {
    const cp = str.codePointAt(i)!
    const charLen = cp > 0xffff ? 2 : 1

    if (cp >= 0x2400 && cp <= 0x241f) {
      const code = cp - 0x2400
      out.push(code)
      if (code === STX) depth++
      else if (code === ETX) {
        depth--
        if (depth === 0) { i += charLen; break }
      }
      i += charLen
    } else {
      const bytes = encoder.encode(String.fromCodePoint(cp))
      for (const b of bytes) out.push(b)
      i += charLen
    }
  }
  return i
}

function writeDataUntilControl(buf: Uint8Array, pos: number, parts: string[]): number {
  while (pos < buf.length && buf[pos] >= 0x20) {
    parts.push(String.fromCharCode(buf[pos]))
    pos++
  }
  return pos
}

function writeFieldsLine(buf: Uint8Array, pos: number, parts: string[]): number {
  const len = buf.length
  while (pos < len) {
    const byte = buf[pos]
    if (byte === US) {
      parts.push(glyph(US))
      pos++
    } else if (byte === DLE) {
      parts.push(glyph(DLE))
      pos++
      if (pos < len) {
        if (buf[pos] < 0x20) parts.push(glyph(buf[pos]))
        else parts.push(String.fromCharCode(buf[pos]))
        pos++
      }
    } else if (byte === ENQ) {
      parts.push(glyph(ENQ))
      pos++
    } else if (byte === ETB) {
      // Commit marker stays on the record's line, with any payload
      parts.push(glyph(ETB))
      pos++
      while (pos < len && buf[pos] >= 0x20) {
        parts.push(String.fromCharCode(buf[pos]))
        pos++
      }
    } else if (byte === STX) {
      parts.push(glyph(STX))
      pos++
      while (pos < len) {
        const b = buf[pos]
        if (b === ETX) {
          parts.push(glyph(ETX))
          pos++
          break
        } else if (b === US) {
          parts.push(glyph(US))
          pos++
        } else if (b < 0x20) {
          parts.push(glyph(b))
          pos++
        } else {
          parts.push(String.fromCharCode(b))
          pos++
        }
      }
    } else if (byte < 0x20) {
      break
    } else {
      parts.push(String.fromCharCode(byte))
      pos++
    }
  }
  return pos
}

function writeIndent(parts: string[], indent: string, depth: number): void {
  for (let i = 0; i < depth; i++) parts.push(indent)
}

// --- Column alignment ---

const G_FS  = glyph(FS)
const G_GS  = glyph(GS)
const G_RS  = glyph(RS)
const G_SOH = glyph(SOH)
const G_US  = glyph(US)
const G_EOT = glyph(EOT)
const G_DLE = glyph(DLE)

const PREFIXES = new Set([G_FS, G_GS, G_RS, G_SOH, G_US])

interface TableLine {
  lineIndex: number
  prefix: string   // indent + prefix glyph(s)
  fields: string[]
}

interface TableGroup {
  lines: TableLine[]
}

/**
 * Reformat a pretty-form string with column alignment.
 *
 * Modes:
 * - `'aligned'` — column alignment only
 * - `'spaced'`  — column alignment + space after prefix + space around ␟
 */
export function align(pretty: string, mode: FormatMode = 'spaced'): string {
  const lines = pretty.split('\n')
  // Remove trailing empty line from split (format always ends with \n)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const groups = findTableGroups(lines)
  const spaced = mode === 'spaced'
  const sp = spaced ? ' ' : ''

  // Build set of line indices handled by table groups
  const tableLineIndices = new Set<number>()
  for (const group of groups) {
    for (const line of group.lines) {
      tableLineIndices.add(line.lineIndex)
    }
  }

  // Format table groups with column alignment
  for (const group of groups) {
    if (group.lines.length < 1) continue

    const colCount = group.lines[0].fields.length
    const maxWidths = new Array<number>(colCount).fill(0)
    for (const line of group.lines) {
      for (let col = 0; col < line.fields.length; col++) {
        maxWidths[col] = Math.max(maxWidths[col], line.fields[col].length)
      }
    }

    for (const line of group.lines) {
      let text = line.prefix + sp
      for (let col = 0; col < line.fields.length; col++) {
        const field = line.fields[col]
        if (col < line.fields.length - 1) {
          text += field.padEnd(maxWidths[col]) + sp + G_US + sp
        } else {
          text += field
        }
      }
      lines[line.lineIndex] = text
    }
  }

  // Format non-table lines: add/remove space after prefix glyphs
  for (let i = 0; i < lines.length; i++) {
    if (tableLineIndices.has(i)) continue
    const text = lines[i]
    if (text.trim() === '') continue

    // Find indent
    let wsEnd = 0
    while (wsEnd < text.length && (text[wsEnd] === ' ' || text[wsEnd] === '\t')) wsEnd++
    const indent = text.slice(0, wsEnd)

    // Find prefix glyphs
    let glyphEnd = wsEnd
    while (glyphEnd < text.length && PREFIXES.has(text[glyphEnd])) glyphEnd++
    // Include SOH after prefix glyphs (e.g. ␝name␁)
    if (glyphEnd > wsEnd && glyphEnd < text.length && text[glyphEnd] === G_SOH) glyphEnd++

    if (glyphEnd === wsEnd) continue  // no prefix glyphs
    if (glyphEnd >= text.length) continue  // no content after prefix

    const glyphs = text.slice(wsEnd, glyphEnd)
    const rest = text.slice(glyphEnd)

    if (spaced) {
      lines[i] = indent + glyphs + ' ' + rest.trimStart()
    } else {
      lines[i] = indent + glyphs + rest.trimStart()
    }
  }

  return lines.join('\n') + '\n'
}

function findTableGroups(lines: string[]): TableGroup[] {
  const groups: TableGroup[] = []
  let current: TableGroup | null = null
  let expectedCols = -1

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const trimmed = text.trim()

    // Group boundaries: empty, FS, GS, EOT
    if (trimmed === '' || trimmed.startsWith(G_GS) || trimmed.startsWith(G_FS) || trimmed.startsWith(G_EOT)) {
      if (current && current.lines.length > 0) groups.push(current)
      current = null
      expectedCols = -1
      continue
    }

    if (trimmed.startsWith(G_SOH) || trimmed.startsWith(G_RS)) {
      const parsed = parseTableLine(i, text)
      if (!parsed || parsed.fields.length < 2) {
        if (current && current.lines.length > 0) groups.push(current)
        current = null
        expectedCols = -1
        continue
      }

      const colCount = parsed.fields.length
      if (current === null || (expectedCols !== -1 && colCount !== expectedCols)) {
        if (current && current.lines.length > 0) groups.push(current)
        current = { lines: [] }
        expectedCols = colCount
      }

      current.lines.push(parsed)
    } else {
      if (current && current.lines.length > 0) groups.push(current)
      current = null
      expectedCols = -1
    }
  }

  if (current && current.lines.length > 0) groups.push(current)
  return groups
}

function parseTableLine(lineIndex: number, text: string): TableLine | null {
  // Find the prefix glyph (SOH or RS)
  let markerPos = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' || text[i] === '\t') continue
    if (text[i] === G_SOH || text[i] === G_RS) {
      markerPos = i
      break
    }
    return null
  }
  if (markerPos === -1) return null

  const prefix = text.slice(0, markerPos + 1)
  const rest = text.slice(markerPos + 1)

  // Split on US glyph, respecting DLE escapes
  const fields: string[] = []
  let field = ''
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === G_DLE && i + 1 < rest.length) {
      field += rest[i] + rest[i + 1]
      i++
    } else if (rest[i] === G_US) {
      fields.push(field.trim())
      field = ''
    } else {
      field += rest[i]
    }
  }
  fields.push(field.trim())

  if (fields.length < 2) return null

  return { lineIndex, prefix, fields }
}
