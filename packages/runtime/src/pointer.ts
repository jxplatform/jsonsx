/**
 * The one `$ref` path grammar — the tokenizer, and the JavaScript accessor built from it.
 *
 * There used to be five, and they disagreed. Two read paths split a path on `/` **and** `.`; the
 * compiler's build-time evaluator split on `/` alone; `resolveWritableRef` split on `/` alone, so a
 * write to `#/state/a/b.c` landed on a key the matching read could never see; and four lowering
 * functions did neither — they ran `replaceAll("/", ".")` and emitted the result as raw member
 * access. That last one is why `#/state/items/0` compiled to `s.items.0`, a SyntaxError, while the
 * build reported success.
 *
 * Segments are separated by `/` and nothing else, which is RFC 6901 §3: the ABNF excludes only `/`
 * and `~` from a reference token, so `.` is an ordinary character and `#/state/user.name` denotes
 * one member literally named `user.name`. Making the dot ordinary is what lets all five paths share
 * this file — it was the only rule they differed on.
 *
 * @docs framework/concepts/references
 */

/** `~1` is `/` and `~0` is `~`; RFC 6901 §4 fixes this order so `~01` becomes `~1`, not `/`. */
export function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** `~` and `/` are the two characters a token cannot carry literally (RFC 6901 §3). */
export function escapeToken(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Split a `$ref` path — the part after its scheme — into member names.
 *
 * An empty path is no segments rather than one empty segment, so `#/state/` reads `state` itself
 * rather than a member named "".
 *
 * @param {string} path - E.g. `user/name`, `items/0`, `a~1b`
 * @returns {string[]} Unescaped member names
 */
export function refSegments(path: string): string[] {
  if (path === "") {
    return [];
  }
  return path.split("/").map((token) => unescapeToken(token));
}

/**
 * Walk a value along a `$ref` path, or `undefined` where the path leaves the object.
 *
 * @param {unknown} root
 * @param {string} path
 * @returns {unknown}
 */
export function readPath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of refSegments(path)) {
    current = (current as Record<string, unknown> | null | undefined)?.[key];
  }
  return current;
}

/**
 * A segment that can follow a `.` — deliberately ASCII-only, so anything exotic takes the bracket
 * branch rather than relying on this regex to model ECMAScript's full identifier grammar. Reserved
 * words are fine: `s.class` and `s.new` are legal member accesses.
 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A JavaScript expression reading `path` from `base`.
 *
 * Dotted where a segment is genuinely an identifier, bracketed with a JSON-quoted key where it is
 * not — the emitted module is read in devtools by the site's author, and `state.cart.push(3)` is
 * worth keeping over `state["cart"].push(3)`.
 *
 * The bug was never dot notation; it was dot notation with no other branch. The compiler ran
 * `replaceAll("/", ".")` unconditionally, so `#/state/items/0` became `s.items.0` — a SyntaxError
 * emitted by a build that reported success — and a key holding a hyphen or a space did the same.
 * `$args/` already bracketed everything, which is why shipped `$args/values/0` formulas worked
 * while `#/state/items/0` did not. One rule now, with the safe branch as the fallback.
 *
 * @param {string} base - Receiver expression, e.g. `s` or `_args`
 * @param {string} path
 * @returns {string}
 */
export function refAccessor(base: string, path: string): string {
  let expr = base;
  for (const key of refSegments(path)) {
    expr += IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  return expr;
}

/**
 * An object-literal key: bare where it is an identifier, JSON-quoted where it is not.
 *
 * Both forms are valid JavaScript, so this is only about what the emitted module reads like — and
 * quoting is the branch that has to exist, because a document may legally declare a state key of
 * `user.name` and pasting that raw produced `user.name: 1,`, a SyntaxError.
 *
 * @param {string} key
 * @returns {string}
 */
export function objectKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/**
 * A safe identifier naming one binding in a generated `bind`/`on` map.
 *
 * The key is emitted as an object-literal key _and_ as a `data-bind` attribute value _and_ as
 * `on.<key>` member access, so unlike {@link objectKey} it cannot fall back to quoting — it has to
 * be an identifier outright. Every character outside `[A-Za-z0-9_$]` becomes `_` and a leading
 * digit gains a prefix; nothing else is touched.
 *
 * `$` is deliberately kept. Folding it would rename the `$handler` key while the emitted call site
 * still said `on.$handler`, unbinding the handler with no error anywhere. Runs of `_` are likewise
 * left alone: collapsing them made `a__b` and `a_b` collide for cosmetic reasons.
 *
 * Distinct paths can still collide (`a/b` and `a.b` both give `a_b`); callers needing uniqueness
 * compare the paths themselves.
 *
 * @param {string} ref - The ref, prefix already stripped by the caller
 * @returns {string}
 */
export function refBindingKey(ref: string): string {
  const safe = ref.replaceAll(/[^A-Za-z0-9_$]/g, "_");
  if (safe === "") {
    return "ref";
  }
  return /^\d/.test(safe) ? `_${safe}` : safe;
}
