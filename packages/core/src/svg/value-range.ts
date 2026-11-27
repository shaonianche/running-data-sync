/**
 * Closed numeric interval `[lower, upper]` built incrementally via `extend`.
 */
export class ValueRange {
  private _lower: number | null = null
  private _upper: number | null = null

  static fromPair(value1: number, value2: number): ValueRange {
    const range = new ValueRange()
    range.extend(value1)
    range.extend(value2)
    return range
  }

  isValid(): boolean {
    return this._lower !== null && this._upper !== null
  }

  get lower(): number {
    if (this._lower === null) {
      throw new Error('ValueRange is empty')
    }
    return this._lower
  }

  get upper(): number {
    if (this._upper === null) {
      throw new Error('ValueRange is empty')
    }
    return this._upper
  }

  diameter(): number {
    if (!this.isValid()) {
      return 0
    }
    return this.upper - this.lower
  }

  contains(value: number): boolean {
    return this.isValid() && this.lower <= value && value <= this.upper
  }

  extend(value: number): void {
    if (!this.isValid()) {
      this._lower = value
      this._upper = value
      return
    }
    this._lower = Math.min(this._lower!, value)
    this._upper = Math.max(this._upper!, value)
  }
}
