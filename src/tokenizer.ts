import { SOH, STX, ETX, EOT, ENQ, DLE, SUB, FS, GS, RS, US, ASSIGNED } from './constants.js'
import { UnassignedCodeError, UnexpectedEndError } from './error.js'
import { Token, TokenType } from './token.js'

const CONTROL_TO_TOKEN: Partial<Record<number, TokenType>> = {
  [SOH]: TokenType.SOH,
  [STX]: TokenType.STX,
  [ETX]: TokenType.ETX,
  [EOT]: TokenType.EOT,
  [ENQ]: TokenType.ENQ,
  [SUB]: TokenType.SUB,
  [FS]:  TokenType.FS,
  [GS]:  TokenType.GS,
  [RS]:  TokenType.RS,
  [US]:  TokenType.US,
}

/**
 * High-performance tokenizer for C0DATA.
 *
 * Scans a byte buffer for control codes (< 0x20) and emits tokens as
 * offsets into the original buffer. No allocation for data values.
 */
export function tokenize(buf: Uint8Array): Token[] {
  const tokens: Token[] = []
  tokenizeEach(buf, t => { tokens.push(t) })
  return tokens
}

/**
 * Streaming tokenizer — calls the callback for each token.
 */
export function tokenizeEach(buf: Uint8Array, cb: (token: Token) => void): void {
  let pos = 0
  const len = buf.length

  while (pos < len) {
    const byte = buf[pos]

    if (byte < 0x20) {
      if (byte === DLE) {
        // Escape: consume DLE + next byte, emit Data token for escaped byte
        pos++ // skip DLE
        if (pos >= len) throw new UnexpectedEndError()
        cb({ type: TokenType.Data, start: pos, end: pos + 1 })
        pos++
      } else {
        const tokenType = CONTROL_TO_TOKEN[byte]
        if (tokenType === undefined) {
          throw new UnassignedCodeError(byte, pos)
        }
        cb({ type: tokenType, start: pos, end: pos + 1 })
        pos++
      }
    } else {
      // Scan data run
      const start = pos
      pos++
      while (pos < len && buf[pos] >= 0x20) {
        pos++
      }
      cb({ type: TokenType.Data, start, end: pos })
    }
  }
}
