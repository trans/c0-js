/** C0DATA control code byte constants. */

export const SOH = 0x01 // Header (field name declarations)
export const STX = 0x02 // Open nested sub-structure / reference scope
export const ETX = 0x03 // Close nested sub-structure / reference scope
export const EOT = 0x04 // End of document / message
export const ENQ = 0x05 // Reference (enquiry — look up named data)
export const DLE = 0x10 // Escape (next byte is literal)
export const SUB = 0x1a // Substitution (old → new, C0-DIFF)
export const FS  = 0x1c // File / Database separator
export const GS  = 0x1d // Group / Table / Section separator
export const RS  = 0x1e // Record / Row separator
export const US  = 0x1f // Unit / Field separator

/** Set of assigned control code bytes. */
export const ASSIGNED: ReadonlySet<number> = new Set([
  SOH, STX, ETX, EOT, ENQ, DLE, SUB, FS, GS, RS, US,
])
