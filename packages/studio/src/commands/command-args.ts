/**
 * Command-args.ts — loud coercion for the arguments a command record declares.
 *
 * Every scriptable command carries an `args` JSON Schema (spec §13.1, plan §13.3): the palette
 * prompts from it, the AI tool's parameters are it, and `scripts/check-shot-contract.ts` validates
 * every manifest step against it in the `checks` job. This module is the RUNTIME half of that same
 * declaration — the four lines inside `run` that turn `Record<string, unknown>` into the typed
 * value the implementation wants.
 *
 * Two rules, and they are the reason this is a module rather than twelve copies of `String(x)`:
 *
 * 1. **Reject loudly, never clamp.** An unknown panel id, a mode the tab cannot enter, a selection
 *    path that is not in the document — each throws. A no-op would photograph the previous state
 *    and a docs build would accept it; a clamp would photograph a state the caller did not ask for.
 *    Plan §13.4 makes this a tested property.
 * 2. **The failure names the fix.** `{@link enumArg}` prints the declared values, which is what makes
 *    §13.5's headline failure — _manifest shot "properties-bar" names panel "head"; the registry
 *    declares "page"_ — a sentence a reader can act on rather than a stack trace. Nothing else in
 *    this file matters as much as that message.
 *
 * `RangeError` (not a bespoke class) because `services/profile.ts` already throws it for exactly
 * this — an id outside a declared set — and one refusal shape is easier to catch than two.
 */

/** Arguments as they arrive from a palette prompt, a manifest step or an AI tool call. */
export type CommandArgValues = Record<string, unknown>;

/** `command "<id>" argument "<key>": <problem>` — the one sentence shape every failure here uses. */
function refuse(commandId: string, key: string, problem: string): RangeError {
  return new RangeError(`command "${commandId}" argument "${key}": ${problem}`);
}

/** How a received value is quoted back to the caller. Strings keep their quotes; nothing is elided. */
function describe(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  return typeof value === "string" ? `"${value}"` : `${typeof value} ${JSON.stringify(value)}`;
}

/** A required string argument. */
export function stringArg(commandId: string, args: CommandArgValues, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw refuse(commandId, key, `expected a non-empty string, got ${describe(value)}`);
  }
  return value;
}

/** An optional string argument — `undefined` when absent, never coerced from another type. */
export function optionalStringArg(
  commandId: string,
  args: CommandArgValues,
  key: string,
): string | undefined {
  if (args[key] === undefined) {
    return undefined;
  }
  return stringArg(commandId, args, key);
}

/** A required finite number argument. `NaN` and `Infinity` are refusals, not values. */
export function numberArg(commandId: string, args: CommandArgValues, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw refuse(commandId, key, `expected a finite number, got ${describe(value)}`);
  }
  return value;
}

/**
 * A required number argument inside a closed interval.
 *
 * REJECTS out of range rather than clamping, which is the difference between a shot that fails and
 * a shot that photographs 500% when it asked for 1000% — the second is a wrong picture the docs
 * build accepts. The interactive controls still clamp: dragging a slider past its end is a gesture
 * with an obvious meaning, whereas a caller naming a number outside the range is stating something
 * untrue about the app.
 */
export function boundedNumberArg(
  commandId: string,
  args: CommandArgValues,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = numberArg(commandId, args, key);
  if (value < minimum || value > maximum) {
    throw refuse(commandId, key, `${value} is outside the supported range ${minimum}–${maximum}`);
  }
  return value;
}

/** A required boolean argument. A setter's whole point is that `false` is a value, so no default. */
export function booleanArg(commandId: string, args: CommandArgValues, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw refuse(commandId, key, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

/**
 * A required argument drawn from a declared set.
 *
 * The `declared:` clause is the point — see the module header. It is printed in full rather than
 * truncated: these sets are panel ids and tab ids, never long enough to be a wall, and a reader
 * comparing a stale id against the current list needs the whole list.
 */
export function enumArg<T extends string>(
  commandId: string,
  args: CommandArgValues,
  key: string,
  declared: readonly T[],
): T {
  const value = args[key];
  if (typeof value !== "string" || !(declared as readonly string[]).includes(value)) {
    throw refuse(
      commandId,
      key,
      `${describe(value)} is not declared — declared: ${declared.join(", ")}`,
    );
  }
  return value as T;
}

/**
 * A document path (`JxPath`) argument: an array of strings and numbers.
 *
 * The empty array is the document root and therefore VALID — `selection.set { path: [] }` is how a
 * shot selects the root element, and treating `[]` as "no path" would silently deselect instead.
 */
export function pathArg(
  commandId: string,
  args: CommandArgValues,
  key: string,
): (string | number)[] {
  const value = args[key];
  if (
    !Array.isArray(value) ||
    !value.every((s) => typeof s === "string" || typeof s === "number")
  ) {
    throw refuse(
      commandId,
      key,
      `expected an array of path segments (strings or numbers), got ${describe(value)}`,
    );
  }
  return value as (string | number)[];
}

/** A path argument that may be `null` — "select nothing" is a state a user can be in. */
export function nullablePathArg(
  commandId: string,
  args: CommandArgValues,
  key: string,
): (string | number)[] | null {
  if (args[key] === null) {
    return null;
  }
  return pathArg(commandId, args, key);
}

/**
 * A LIST of document paths — the whole selection set (§6.5).
 *
 * Every element is validated as a path, so a caller that passes one bare path by mistake
 * (`["children", 0]` rather than `[["children", 0]]`) is refused by name instead of selecting two
 * nodes called "children" and "0". `[]` is legal and means "select nothing", which is the same
 * thing `selection.set { path: null }` means.
 */
export function pathListArg(
  commandId: string,
  args: CommandArgValues,
  key: string,
): (string | number)[][] {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw refuse(commandId, key, `expected an array of document paths, got ${describe(value)}`);
  }
  return value.map((entry, i) => {
    if (
      !Array.isArray(entry) ||
      !entry.every((s) => typeof s === "string" || typeof s === "number")
    ) {
      throw refuse(
        commandId,
        key,
        `entry ${i} is not a document path — expected an array of segments, got ${describe(entry)}`,
      );
    }
    return entry as (string | number)[];
  });
}

// ─── Schema fragments ─────────────────────────────────────────────────────────
// The declarations above are enforced at RUN time; these are the same facts in the form the palette
// Prompt, the AI tool's parameter list and Lane 1's static check read. Keeping the pair adjacent is
// Deliberate: a schema that disagrees with its coercion is the defect this module exists to prevent.

/** `{ type: "object", properties, required, additionalProperties: false }` in one call. */
export function argsSchema(
  properties: Record<string, object>,
  required: readonly string[] = Object.keys(properties),
): object {
  return {
    additionalProperties: false,
    properties,
    required: [...required],
    type: "object",
  };
}

/** A string property constrained to a declared set, with the human sentence the palette shows. */
export function enumProperty(declared: readonly string[], description: string): object {
  return { description, enum: [...declared], type: "string" };
}

/** A number property, optionally bounded — the bounds a control already enforces, written down. */
export function numberProperty(
  description: string,
  bounds: { minimum?: number; maximum?: number } = {},
): object {
  return { description, type: "number", ...bounds };
}

/** A boolean property. Named `open`/`enabled`/… by the caller; the description carries the sense. */
export function booleanProperty(description: string): object {
  return { description, type: "boolean" };
}

/** A `JxPath` property — an array of string keys and numeric indexes. */
export function pathProperty(description: string, nullable = false): object {
  const path = {
    items: { type: ["string", "number"] },
    type: "array",
  };
  return nullable ? { description, oneOf: [path, { type: "null" }] } : { description, ...path };
}

/** A property holding a LIST of `JxPath`s — an array of arrays of segments. */
export function pathListProperty(description: string): object {
  return {
    description,
    items: { items: { type: ["string", "number"] }, type: "array" },
    type: "array",
  };
}

/** A free-form string property. */
export function stringProperty(description: string): object {
  return { description, type: "string" };
}
