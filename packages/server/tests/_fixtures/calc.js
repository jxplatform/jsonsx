
export class Calculator {
  constructor(/** @type {{ a?: number; b?: number }} */ config) { this.a = config.a ?? 0; this.b = config.b ?? 0; }
  async resolve() { return this.a * this.b; }
}
