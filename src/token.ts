export const enum TokenType {
  Data = 0,
  SOH = 1,
  STX = 2,
  ETX = 3,
  EOT = 4,
  ENQ = 5,
  DLE = 6,  // consumed during tokenization, not emitted
  SUB = 7,
  FS  = 8,
  GS  = 9,
  RS  = 10,
  US  = 11,
  ETB = 12,  // commit marker (stream mode)
}

export interface Token {
  readonly type: TokenType
  readonly start: number
  readonly end: number
}

/** Returns the byte length of a token's data. */
export function tokenSize(t: Token): number {
  return t.end - t.start
}

/** Returns the value as a slice into the given buffer. Zero-copy. */
export function tokenValue(t: Token, buf: Uint8Array): Uint8Array {
  return buf.subarray(t.start, t.end)
}
