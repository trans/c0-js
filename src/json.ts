import { SOH, STX, ETX, EOT, DLE, FS, GS, RS, US } from './constants.js'
import { Table } from './table.js'
import { Document } from './document.js'

const decoder = new TextDecoder()

/** Recursive value type for intermediate data structures. */
export type Value = string | Value[] | { [key: string]: Value }

// --- Export: C0DATA → JSON/YAML ---

/** Convert C0DATA compact bytes to a JSON string. */
export function toJSON(buf: Uint8Array): string {
  return JSON.stringify(exportValue(buf), null, 2)
}

/** Convert C0DATA compact bytes to a JS value. */
export function toObject(buf: Uint8Array): Value {
  return exportValue(buf)
}

/** Convert JSON string to C0DATA compact bytes. */
export function fromJSON(input: string, groupName: string = 'data'): Uint8Array {
  const value = JSON.parse(input)
  const out: number[] = []
  emitRoot(jsonToValue(value), groupName, out)
  return new Uint8Array(out)
}

/** Convert a JS value to C0DATA compact bytes. */
export function fromObject(value: unknown, groupName: string = 'data'): Uint8Array {
  const out: number[] = []
  emitRoot(jsonToValue(value), groupName, out)
  return new Uint8Array(out)
}

// --- Internal export ---

function exportValue(buf: Uint8Array): Value {
  if (buf.length > 0 && buf[0] === FS) {
    const doc = new Document(buf)
    return exportDocument(doc)
  } else if (buf.length > 0 && buf[0] === GS) {
    const table = new Table(buf)
    const name = decoder.decode(table.name)
    return { [name]: exportGroupData(table) }
  }
  return {}
}

function exportDocument(doc: Document): Value {
  const name = decoder.decode(doc.name)
  const groups: { [key: string]: Value } = {}
  doc.eachGroup(group => {
    groups[decoder.decode(group.name)] = exportGroupData(group.table)
  })

  if (name === '') return groups
  return { [name]: groups }
}

function exportGroupData(table: Table): Value {
  if (table.headerCount > 0) {
    return exportTable(table)
  } else if (table.recordCount > 0 && table.record(0).fieldCount === 2) {
    return exportKV(table)
  } else if (table.recordCount > 0) {
    return exportRecords(table)
  }
  return []
}

function exportTable(table: Table): Value {
  const headers: string[] = []
  for (let i = 0; i < table.headerCount; i++) {
    headers.push(decoder.decode(table.header(i)))
  }

  const rows: Value[] = []
  table.eachRecord(rec => {
    const row: { [key: string]: Value } = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = fieldToValue(rec.field(i))
    }
    rows.push(row)
  })
  return rows
}

function exportKV(table: Table): Value {
  const obj: { [key: string]: Value } = {}
  table.eachRecord(rec => {
    obj[unescape(rec.field(0))] = fieldToValue(rec.field(1))
  })
  return obj
}

function exportRecords(table: Table): Value {
  const rows: Value[] = []
  table.eachRecord(rec => {
    const fields: Value[] = []
    for (let i = 0; i < rec.fieldCount; i++) {
      fields.push(fieldToValue(rec.field(i)))
    }
    rows.push(fields)
  })
  return rows
}

function fieldToValue(field: Uint8Array): Value {
  if (field.length > 0 && field[0] === STX) {
    return parseNestedField(field)
  }
  return unescape(field)
}

function parseNestedField(field: Uint8Array): Value {
  let stop = field.length
  if (stop > 0 && field[stop - 1] === ETX) stop--
  let pos = 1 // skip STX

  // Detect structure: scan for RS at top level
  let hasRS = false
  let scan = pos
  while (scan < stop) {
    const byte = field[scan]
    if (byte === RS) { hasRS = true; break }
    if (byte === STX) { scan = skipNestedBytes(field, scan, stop) }
    else if (byte === DLE) { scan += 2 }
    else { scan++ }
  }

  return hasRS
    ? parseNestedKV(field, pos, stop)
    : parseNestedArray(field, pos, stop)
}

function parseNestedKV(field: Uint8Array, pos: number, stop: number): Value {
  const obj: { [key: string]: Value } = {}
  while (pos < stop) {
    if (field[pos] === RS) {
      pos++
      const keyStart = pos
      while (pos < stop && field[pos] !== US) {
        if (field[pos] === DLE) pos += 2
        else pos++
      }
      const key = unescape(field.subarray(keyStart, pos))
      if (pos < stop && field[pos] === US) {
        pos++
        const valStart = pos
        while (pos < stop && field[pos] !== RS) {
          if (field[pos] === STX) pos = skipNestedBytes(field, pos, stop)
          else if (field[pos] === DLE) pos += 2
          else pos++
        }
        obj[key] = fieldToValue(field.subarray(valStart, pos))
      } else {
        obj[key] = ''
      }
    } else {
      pos++
    }
  }
  return obj
}

function parseNestedArray(field: Uint8Array, pos: number, stop: number): Value {
  const items: Value[] = []
  while (pos < stop) {
    if (field[pos] === US) {
      pos++
      const itemStart = pos
      while (pos < stop && field[pos] !== US) {
        if (field[pos] === STX) pos = skipNestedBytes(field, pos, stop)
        else if (field[pos] === DLE) pos += 2
        else pos++
      }
      items.push(fieldToValue(field.subarray(itemStart, pos)))
    } else {
      pos++
    }
  }
  return items
}

function skipNestedBytes(buf: Uint8Array, pos: number, stop: number): number {
  pos++ // skip STX
  let depth = 1
  while (pos < stop && depth > 0) {
    if (buf[pos] === STX) depth++
    else if (buf[pos] === ETX) depth--
    else if (buf[pos] === DLE) pos++
    pos++
  }
  return pos
}

// --- Internal import ---

function jsonToValue(any: unknown): Value {
  if (any === null || any === undefined) return ''
  if (typeof any === 'string') return any
  if (typeof any === 'number' || typeof any === 'boolean') return String(any)
  if (Array.isArray(any)) return any.map(v => jsonToValue(v))
  if (typeof any === 'object') {
    const result: { [key: string]: Value } = {}
    for (const [k, v] of Object.entries(any as Record<string, unknown>)) {
      result[k] = jsonToValue(v)
    }
    return result
  }
  return String(any)
}

function emitRoot(value: Value, groupName: string, out: number[]): void {
  if (typeof value === 'string') {
    writeGroup(groupName, out)
    out.push(RS)
    writeEscaped(value, out)
  } else if (Array.isArray(value)) {
    emitArrayAsGroup(value, groupName, out)
  } else {
    const hash = value as { [key: string]: Value }
    if (allScalar(hash)) {
      writeGroup(groupName, out)
      for (const [k, v] of Object.entries(hash)) {
        out.push(RS)
        writeEscaped(k, out)
        out.push(US)
        writeEscaped(v as string, out)
      }
    } else if (Object.keys(hash).length === 1) {
      const key = Object.keys(hash)[0]
      const inner = hash[key]
      if (typeof inner === 'object' && !Array.isArray(inner) && allGroupable(inner as { [key: string]: Value })) {
        out.push(FS)
        pushString(key, out)
        emitHashAsGroups(inner as { [key: string]: Value }, out)
      } else {
        emitHashAsGroups(hash, out)
      }
    } else {
      emitHashAsGroups(hash, out)
    }
  }
}

function emitHashAsGroups(hash: { [key: string]: Value }, out: number[]): void {
  for (const [name, value] of Object.entries(hash)) {
    if (typeof value === 'string') {
      writeGroup(name, out)
      out.push(RS)
      writeEscaped(value, out)
    } else if (Array.isArray(value)) {
      emitArrayAsGroup(value, name, out)
    } else {
      const h = value as { [key: string]: Value }
      writeGroup(name, out)
      for (const [k, v] of Object.entries(h)) {
        out.push(RS)
        writeEscaped(k, out)
        out.push(US)
        emitFieldValue(v, out)
      }
    }
  }
}

function emitArrayAsGroup(arr: Value[], name: string, out: number[]): void {
  if (tabular(arr)) {
    const headers = Object.keys(arr[0] as { [key: string]: Value })
    writeGroup(name, out)
    out.push(SOH)
    for (let i = 0; i < headers.length; i++) {
      if (i > 0) out.push(US)
      pushString(headers[i], out)
    }
    for (const row of arr) {
      const h = row as { [key: string]: Value }
      out.push(RS)
      for (let i = 0; i < headers.length; i++) {
        if (i > 0) out.push(US)
        emitFieldValue(h[headers[i]] ?? '', out)
      }
    }
  } else {
    writeGroup(name, out)
    for (const item of arr) {
      if (typeof item === 'string') {
        out.push(RS)
        writeEscaped(item, out)
      } else if (Array.isArray(item)) {
        out.push(RS)
        for (let i = 0; i < item.length; i++) {
          if (i > 0) out.push(US)
          emitFieldValue(item[i], out)
        }
      } else {
        const h = item as { [key: string]: Value }
        for (const [k, v] of Object.entries(h)) {
          out.push(RS)
          writeEscaped(k, out)
          out.push(US)
          emitFieldValue(v, out)
        }
      }
    }
  }
}

function emitFieldValue(value: Value, out: number[]): void {
  if (typeof value === 'string') {
    writeEscaped(value, out)
  } else if (Array.isArray(value)) {
    out.push(STX)
    for (const item of value) {
      out.push(US)
      emitFieldValue(item, out)
    }
    out.push(ETX)
  } else {
    const h = value as { [key: string]: Value }
    out.push(STX)
    for (const [k, v] of Object.entries(h)) {
      out.push(RS)
      writeEscaped(k, out)
      out.push(US)
      emitFieldValue(v, out)
    }
    out.push(ETX)
  }
}

// --- Helpers ---

const enc = new TextEncoder()

function writeGroup(name: string, out: number[]): void {
  out.push(GS)
  pushString(name, out)
}

function pushString(s: string, out: number[]): void {
  const bytes = enc.encode(s)
  for (const b of bytes) out.push(b)
}

function writeEscaped(str: string, out: number[]): void {
  const bytes = enc.encode(str)
  for (const b of bytes) {
    if (b < 0x20) out.push(DLE)
    out.push(b)
  }
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

function allScalar(hash: { [key: string]: Value }): boolean {
  return Object.values(hash).every(v => typeof v === 'string')
}

function allGroupable(hash: { [key: string]: Value }): boolean {
  return Object.values(hash).every(v => typeof v === 'object')
}

function tabular(arr: Value[]): boolean {
  if (arr.length === 0) return false
  if (!arr.every(item => typeof item === 'object' && !Array.isArray(item))) return false
  const keys = Object.keys(arr[0] as { [key: string]: Value })
  return arr.every(item => {
    const k = Object.keys(item as { [key: string]: Value })
    return k.length === keys.length && k.every((key, i) => key === keys[i])
  })
}
