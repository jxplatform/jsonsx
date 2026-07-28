/// <reference lib="dom" />
/**
 * Base64 encoding for binary upload payloads.
 *
 * `StudioPlatform.uploadFile` accepts `string | File | Blob | ArrayBuffer`, but the RPC platforms
 * (electrobun, chromium) JSON-serialize their params — a `File`/`Blob` becomes `{}` on the wire.
 * Those platforms encode here before the call; the HTTP platforms (dev server, cloud) post the
 * binary body directly and must NOT use this.
 */

/** Bytes per `String.fromCodePoint` call — spreading a whole large file blows the call stack. */
const CHUNK = 32_768;

/** Base64-encode raw bytes without blowing the call stack on spread. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Normalize an upload payload to base64. A `string` passes through unchanged — the RPC backends
 * have always received base64 strings, so existing callers keep working.
 */
export async function toBase64(data: string | File | Blob | ArrayBuffer): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}
