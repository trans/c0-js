import { DLE, FS } from './constants.js'
import { build } from './builder.js'
import { Table } from './table.js'
import { Document } from './document.js'

const decoder = new TextDecoder()

/**
 * Convert CSV text to C0DATA compact bytes.
 *
 * The first row is treated as headers, remaining rows as records.
 */
export function fromCSV(input: string, groupName: string = 'data'): Uint8Array {
  const rows = parseCSV(input)
  if (rows.length === 0) return new Uint8Array(0)

  return build(b => {
    const headers = rows[0]
    b.group(groupName, headers, () => {
      for (let i = 1; i < rows.length; i++) {
        b.recordArray(rows[i])
      }
    })
  })
}

/**
 * Convert C0DATA compact bytes to CSV text.
 */
export function toCSV(buf: Uint8Array): string {
  const table = findTable(buf)
  const rows: string[][] = []

  if (table.headerCount > 0) {
    const headerRow: string[] = []
    for (let i = 0; i < table.headerCount; i++) {
      headerRow.push(decoder.decode(table.header(i)))
    }
    rows.push(headerRow)
  }

  table.eachRecord(rec => {
    const row: string[] = []
    for (let i = 0; i < rec.fieldCount; i++) {
      row.push(unescape(rec.field(i)))
    }
    rows.push(row)
  })

  return rows.map(row =>
    row.map(field => {
      if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return '"' + field.replace(/"/g, '""') + '"'
      }
      return field
    }).join(',')
  ).join('\n') + '\n'
}

function findTable(buf: Uint8Array): Table {
  if (buf.length > 0 && buf[0] === FS) {
    const doc = new Document(buf)
    if (doc.groupCount > 0) {
      return doc.group(0).table
    }
  }
  return new Table(buf)
}

function unescape(field: Uint8Array): string {
  let hasDLE = false
  for (let i = 0; i < field.length; i++) {
    if (field[i] === DLE) { hasDLE = true; break }
  }
  if (!hasDLE) return decoder.decode(field)

  const out: number[] = []
  let pos = 0
  while (pos < field.length) {
    if (field[pos] === DLE && pos + 1 < field.length) {
      pos++
      out.push(field[pos])
    } else {
      out.push(field[pos])
    }
    pos++
  }
  return decoder.decode(new Uint8Array(out))
}

/** Simple CSV parser that handles quoted fields. */
function parseCSV(input: string): string[][] {
  const rows: string[][] = []
  let pos = 0
  const len = input.length

  while (pos < len) {
    const row: string[] = []
    while (pos < len) {
      if (input[pos] === '"') {
        // Quoted field
        pos++ // skip opening quote
        let field = ''
        while (pos < len) {
          if (input[pos] === '"') {
            if (pos + 1 < len && input[pos + 1] === '"') {
              field += '"'
              pos += 2
            } else {
              pos++ // skip closing quote
              break
            }
          } else {
            field += input[pos]
            pos++
          }
        }
        row.push(field)
      } else {
        // Unquoted field
        let field = ''
        while (pos < len && input[pos] !== ',' && input[pos] !== '\n' && input[pos] !== '\r') {
          field += input[pos]
          pos++
        }
        row.push(field)
      }

      if (pos < len && input[pos] === ',') {
        pos++ // skip comma
      } else {
        break
      }
    }

    // Skip line ending
    if (pos < len && input[pos] === '\r') pos++
    if (pos < len && input[pos] === '\n') pos++

    if (row.length > 0) rows.push(row)
  }
  return rows
}
