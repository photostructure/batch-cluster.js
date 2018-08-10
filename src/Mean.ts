export class Mean {
  private _n: number
  private _min?: number = undefined
  private _max?: number = undefined

  constructor(n: number = 0, private sum: number = 0) {
    this._n = n
  }

  push(x: number) {
    this._n++
    this.sum += x
    this._min = this._min == null || this._min > x ? x : this._min
    this._max = this._max == null || this._max < x ? x : this._max
  }

  get n(): number {
    return this._n
  }

  get min(): number | undefined {
    return this._min
  }

  get max(): number | undefined {
    return this._max
  }

  get mean(): number {
    return this.sum / this.n
  }

  clone(): Mean {
    return new Mean(this.n, this.sum)
  }
}
