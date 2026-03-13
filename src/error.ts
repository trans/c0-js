export class C0Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'C0Error'
  }
}

export class UnassignedCodeError extends C0Error {
  readonly byte: number
  readonly position: number

  constructor(byte: number, position: number) {
    super(`Unassigned control code 0x${byte.toString(16).padStart(2, '0')} at position ${position}`)
    this.name = 'UnassignedCodeError'
    this.byte = byte
    this.position = position
  }
}

export class UnexpectedEndError extends C0Error {
  constructor() {
    super('Unexpected end of input after DLE escape')
    this.name = 'UnexpectedEndError'
  }
}
