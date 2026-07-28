/**
 * Base64 upload encoding — the shim that lets the RPC desktop platforms carry binary over a
 * JSON-serialized wire (a File/Blob would otherwise serialize to `{}`).
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { bytesToBase64, toBase64 } from "../src/utils/base64";

describe("bytesToBase64", () => {
  test("encodes bytes", () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  });

  test("encodes the empty buffer", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  test("chunks past the 32KiB spread limit without blowing the stack", () => {
    // A single String.fromCodePoint(...bytes) at this size overflows the call stack; the chunked
    // Loop is the reason this function exists.
    const bytes = new Uint8Array(100_000).fill(65);
    const encoded = bytesToBase64(bytes);
    expect(atob(encoded)).toHaveLength(100_000);
    expect(atob(encoded).startsWith("AAA")).toBe(true);
  });

  test("survives high bytes (not just ASCII)", () => {
    const bytes = new Uint8Array([0, 127, 128, 255]);
    const round = atob(bytesToBase64(bytes));
    expect([...round].map((c) => c.codePointAt(0))).toEqual([0, 127, 128, 255]);
  });
});

describe("toBase64", () => {
  test("a string passes through untouched — desktop callers already send base64", async () => {
    expect(await toBase64("YWxyZWFkeQ==")).toBe("YWxyZWFkeQ==");
  });

  test("encodes a Blob", async () => {
    expect(await toBase64(new Blob(["hi"]))).toBe("aGk=");
  });

  test("encodes a File", async () => {
    expect(await toBase64(new File(["hi"], "a.txt"))).toBe("aGk=");
  });

  test("encodes a raw ArrayBuffer", async () => {
    expect(await toBase64(new Uint8Array([104, 105]).buffer)).toBe("aGk=");
  });
});
