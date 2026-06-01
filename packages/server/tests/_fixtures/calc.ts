
export class Calculator {
  a: number;
  b: number;
  constructor(config: { a?: number; b?: number }) { this.a = config.a ?? 0; this.b = config.b ?? 0; }
  async resolve() { return this.a * this.b; }
}
