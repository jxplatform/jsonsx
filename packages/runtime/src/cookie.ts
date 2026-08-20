/**
 * The `Cookie` state `$prototype`'s reading and writing, split out because both halves are exactly
 * the places a cookie binding goes wrong (RFC 6265bis).
 *
 * **Reading does not build a regular expression.** The cookie's name comes from the document, and
 * the old reader interpolated it straight into a pattern — so a name containing a dot, a paren or a
 * star silently matched the wrong cookie, and one containing an unbalanced bracket threw
 * SyntaxError from a document that validates. There is nothing to escape here: the cookie header is
 * a semicolon-separated list, so splitting it and comparing names is both correct and cheaper.
 *
 * **`HttpOnly` is absent on purpose, and must stay absent.** A cookie this prototype writes is
 * written by script through `document.cookie`; the browser refuses to _set_ `HttpOnly` from script
 * and refuses to _read back_ an `HttpOnly` cookie, so adding the attribute would produce a binding
 * that writes a value it can never see again. Its absence is the correct behavior for a
 * script-written cookie, not a missing feature.
 *
 * **`Expires` is not supported, and that is also deliberate.** `Max-Age` covers the same ground,
 * RFC 6265bis §5.5 makes `Max-Age` win wherever both appear, and `Expires` takes an HTTP-date whose
 * mis-spelling fails silently in the direction of a cookie that never expires.
 */

/** The cookie attributes an `external-class-def` may declare for the `Cookie` `$prototype`. */
export interface CookieOptions {
  domain?: string | undefined;
  maxAge?: number | undefined;
  path?: string | undefined;
  sameSite?: string | undefined;
  secure?: boolean | undefined;
}

/** Cookie names carrying RFC 6265bis §4.1.3 prefixes, which constrain their own attributes. */
const HOST_PREFIX = "__Host-";
const SECURE_PREFIX = "__Secure-";

/**
 * The raw (still percent-encoded) value of `name` in a `document.cookie` header, or null.
 *
 * @param {string} header The full `name=value; name=value` string.
 * @param {string} name
 * @returns {string | null}
 */
export function readCookie(header: string, name: string): string | null {
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1);
    }
  }
  return null;
}

/**
 * Serialize one `document.cookie` assignment, applying the attribute rules a name's prefix and its
 * `SameSite` value already imply.
 *
 * Three of those rules are enforced rather than left to the author, because a browser that
 * disagrees with the attributes **silently drops the cookie** — the write appears to succeed and
 * the value is simply never there again:
 *
 * - `__Host-` requires `Secure`, requires `Path=/`, and forbids `Domain` (RFC 6265bis §4.1.3.2). A
 *   declared `path` or `domain` is overridden rather than honored, since honoring it would produce
 *   a cookie no browser will store.
 * - `__Secure-` requires `Secure` (§4.1.3.1).
 * - `SameSite=None` requires `Secure` (§5.4.7); without it the cookie is rejected outright.
 *
 * @param {string} name
 * @param {unknown} value JSON-encoded, then percent-encoded.
 * @param {CookieOptions} options
 * @returns {string}
 */
export function serializeCookie(name: string, value: unknown, options: CookieOptions): string {
  const hostPrefixed = name.startsWith(HOST_PREFIX);
  const parts = [`${name}=${encodeURIComponent(JSON.stringify(value))}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  const path = hostPrefixed ? "/" : options.path;
  if (path) {
    parts.push(`Path=${path}`);
  }
  if (options.domain && !hostPrefixed) {
    parts.push(`Domain=${options.domain}`);
  }

  const { sameSite } = options;
  const secure =
    options.secure === true ||
    hostPrefixed ||
    name.startsWith(SECURE_PREFIX) ||
    sameSite?.toLowerCase() === "none";
  if (secure) {
    parts.push("Secure");
  }
  if (sameSite) {
    parts.push(`SameSite=${sameSite}`);
  }

  return parts.join("; ");
}
