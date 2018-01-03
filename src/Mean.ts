export class Mean {
  constructor(private n: number = 0, private sum: number = 0) {}

  push(x: number) {
    this.n++
    this.sum += x
  }

  get mean(): number {
    return this.sum / this.n
  }

  clone(): Mean {
    return new Mean(this.n, this.sum)
  }
}
