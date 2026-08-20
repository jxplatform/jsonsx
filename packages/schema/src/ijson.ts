/**
 * I-JSON (RFC 7493): the two ways a JSON document can parse cleanly and still mean something other
 * than what it says.
 *
 * Both matter here more than they would elsewhere, because a Jx document does not stay JSON. It
 * round-trips through markdown frontmatter and through a Yjs CRDT, and each crossing rebuilds the
 * object from the parsed value — so anything `JSON.parse` quietly discarded is discarded for good,
 * and the file the author reopens is not the file they wrote.
 *
 * - **Duplicate names** (§2.3). `JSON.parse` keeps the last and says nothing. In a hand-edited
 *   document — two `state` keys after a bad merge, say — the first one's contents simply vanish.
 * - **Numbers outside the IEEE 754 double range** (§2.2). `9007199254740993` parses to
 *   `9007199254740992`, and the next serialization writes the wrong number back to disk.
 *
 * Implemented as a scan of the source text rather than a `JSON.parse` reviver, because by the time
 * a reviver runs the duplicate is already gone. The scanner is deliberately small: it only needs to
 * know where strings and object keys are, so it does not build a tree or validate the grammar —
 * `JSON.parse` has already done that by the time this is called.
 *
 * @docs framework/agents/authoring-rules
 */

/** One I-JSON violation, located by the path of the object that contains it. */
export interface IJsonProblem {
  kind: "duplicate-key" | "unsafe-number";
  /** Dotted path to the containing object, `""` at the root. */
  path: string;
  /** The duplicated key, or the number literal as written. */
  detail: string;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Find I-JSON violations in already-valid JSON text.
 *
 * @param {string} text - JSON source that `JSON.parse` accepts
 * @returns {IJsonProblem[]} Empty when the document is I-JSON
 */
export function findIJsonProblems(text: string): IJsonProblem[] {
  const problems: IJsonProblem[] = [];
  /**
   * One frame per open `{` or `[`. Arrays carry a path too, so an object inside one is reported
   * under the key that names the array rather than under whatever enclosed it.
   */
  const stack: { kind: "object" | "array"; path: string; keys?: Set<string> }[] = [];
  /** The key most recently read, naming the value that follows it. */
  let pendingKey: string | null = null;
  let index = 0;

  const currentPath = () => stack.at(-1)?.path ?? "";
  const childPath = () =>
    pendingKey === null ? currentPath() : joinPath(currentPath(), pendingKey);

  const readString = (): string => {
    // Assumes text[index] === '"'; returns the decoded value and leaves index past the closer.
    index += 1;
    let out = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") {
        const next = text[index + 1] ?? "";
        // Only `\uXXXX` needs decoding to compare keys correctly; the rest map one-to-one.
        if (next === "u") {
          out += String.fromCodePoint(Number.parseInt(text.slice(index + 2, index + 6), 16));
          index += 6;
        } else {
          out += ESCAPES[next] ?? next;
          index += 2;
        }
        continue;
      }
      if (char === '"') {
        index += 1;
        return out;
      }
      out += char;
      index += 1;
    }
    return out;
  };

  while (index < text.length) {
    const char = text[index]!;

    if (WHITESPACE.has(char) || char === "," || char === ":") {
      index += 1;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(
        char === "{"
          ? { keys: new Set(), kind: "object", path: childPath() }
          : { kind: "array", path: childPath() },
      );
      pendingKey = null;
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      pendingKey = null;
      index += 1;
      continue;
    }

    if (char === '"') {
      const value = readString();
      /*
       * A string is a key when it sits directly inside an object and a `:` follows. Inside an
       * array it is an element, and the same text on the right of a `:` is a value.
       */
      const frame = stack.at(-1);
      if (frame?.kind === "object" && nextMeaningful(text, index) === ":") {
        if (frame.keys!.has(value)) {
          problems.push({ detail: value, kind: "duplicate-key", path: frame.path });
        }
        frame.keys!.add(value);
        pendingKey = value;
      } else {
        pendingKey = null;
      }
      continue;
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      const start = index;
      while (index < text.length && /[\d+.eE-]/.test(text[index]!)) {
        index += 1;
      }
      const literal = text.slice(start, index);
      if (!isSafeJsonNumber(literal)) {
        problems.push({ detail: literal, kind: "unsafe-number", path: childPath() });
      }
      pendingKey = null;
      continue;
    }

    // `true`, `false`, `null`. The grammar is already known good, so a run of letters is enough.
    const before = index;
    while (index < text.length && /[A-Za-z]/.test(text[index]!)) {
      index += 1;
    }
    if (index === before) {
      index += 1;
    }
    pendingKey = null;
  }

  return problems;
}

const ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** The next non-whitespace character at or after `from`, or "" at the end. */
function nextMeaningful(text: string, from: number): string {
  let index = from;
  while (index < text.length && WHITESPACE.has(text[index]!)) {
    index += 1;
  }
  return text[index] ?? "";
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/**
 * True when a number literal survives a round trip through a double.
 *
 * Only integers are judged. A fractional literal is _always_ approximate in binary floating point —
 * `0.1` is not representable either — so flagging those would flag most real documents and say
 * nothing about whether the author's value survived.
 *
 * @param {string} literal
 * @returns {boolean}
 */
export function isSafeJsonNumber(literal: string): boolean {
  if (/[.eE]/.test(literal)) {
    return true;
  }
  const value = Number(literal);
  if (!Number.isFinite(value)) {
    return false;
  }
  // The literal is an integer, so `String(Number(x))` reproduces it exactly when nothing was lost.
  return String(value) === literal.replace(/^\+/, "");
}

/** A one-line description of a problem, for a build error or a warning. */
export function describeIJsonProblem(problem: IJsonProblem): string {
  const where = problem.path === "" ? "the document root" : `"${problem.path}"`;
  return problem.kind === "duplicate-key"
    ? `duplicate key "${problem.detail}" in ${where} — JSON.parse keeps the last one and ` +
        "silently discards the first (RFC 7493 §2.3)"
    : `number ${problem.detail} in ${where} cannot be represented exactly and will change when ` +
        "the document is written back (RFC 7493 §2.2)";
}
