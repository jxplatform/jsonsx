// Fixture class for runtime-gaps-resolve.test.ts (external class resolution)

/** Plain instance: no resolve(), no value — falls through to `value = instance`. */
export class PlainInstance {
  label: string;
  constructor(config: Record<string, unknown>) {
    this.label = String(config.label ?? "plain");
  }
}
