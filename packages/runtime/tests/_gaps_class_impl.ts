// Fixture classes for runtime-gaps-resolve.test.ts (external class resolution)

/** Instance exposes a `value` property — exercises the `"value" in instance` branch. */
export class ValueBox {
  value: unknown;
  constructor(config: Record<string, unknown>) {
    this.value = config.initial ?? "boxed";
  }
}

/** Instance with resolve() + subscribe() — exercises async resolution and subscription. */
export class Resolvable {
  _label: string;
  _subs: ((v: unknown) => void)[] = [];
  constructor(config: Record<string, unknown>) {
    this._label = String(config.label ?? "");
    (globalThis as Record<string, unknown>).__gapsResolvable = this;
  }
  resolve() {
    return Promise.resolve(`resolved:${this._label}`);
  }
  subscribe(cb: (v: unknown) => void) {
    this._subs.push(cb);
  }
  push(v: unknown) {
    for (const cb of this._subs) {
      cb(v);
    }
  }
}

/** Not a class — exercises the TypeError branch in importAndInstantiate. */
export const notAClass = 42;
