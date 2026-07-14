import { describe, expect, test } from "bun:test";
import { decodeFrame, encodeFrame, EnvelopeError, FRAME_CONTROL } from "../src/envelope.ts";
import type { CollabFrame, ControlMessage } from "../src/envelope.ts";
import * as encoding from "lib0/encoding";

function roundtrip(frame: CollabFrame): CollabFrame {
  return decodeFrame(encodeFrame(frame));
}

describe("envelope roundtrip", () => {
  test("doc-sync carries path, epoch, and the opaque sync body", () => {
    const body = new Uint8Array([0, 1, 2, 250, 255]);
    const frame = roundtrip({ body, epoch: 7, path: "pages/index.md", type: "doc-sync" });
    expect(frame).toEqual({ body, epoch: 7, path: "pages/index.md", type: "doc-sync" });
  });

  test("doc-sync with empty body and epoch zero", () => {
    const frame = roundtrip({ body: new Uint8Array(0), epoch: 0, path: "a", type: "doc-sync" });
    expect(frame.type).toBe("doc-sync");
    expect((frame as { body: Uint8Array }).body).toHaveLength(0);
  });

  test("awareness passes its payload through", () => {
    const body = new Uint8Array([9, 8, 7]);
    expect(roundtrip({ body, type: "awareness" })).toEqual({ body, type: "awareness" });
  });

  test("doc-close carries the path (unicode-safe)", () => {
    const frame = roundtrip({ path: "pages/ünïcødé — página.md", type: "doc-close" });
    expect(frame).toEqual({ path: "pages/ünïcødé — página.md", type: "doc-close" });
  });

  test("every control message shape survives", () => {
    const messages: ControlMessage[] = [
      {
        avatarUrl: "https://a.png",
        color: "#4f9cf9",
        login: "octocat",
        name: "Octo",
        permission: "write",
        type: "hello",
      },
      { path: "p.md", type: "open" },
      { epoch: 3, path: "p.md", type: "opened" },
      { epoch: 4, path: "p.md", type: "doc-reset" },
      { path: "p.md", type: "flush" },
      { path: "p.md", type: "flush-ack" },
      { dirty: true, path: "p.md", type: "doc-dirty" },
      { dirty: false, path: "p.md", type: "doc-dirty" },
      { code: "read-only", message: "Write access required", path: "p.md", type: "error" },
    ];
    for (const message of messages) {
      expect(roundtrip({ message, type: "control" })).toEqual({ message, type: "control" });
    }
  });
});

describe("malformed frames", () => {
  test("unknown frame type is rejected", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 42);
    expect(() => decodeFrame(encoding.toUint8Array(encoder))).toThrow(EnvelopeError);
  });

  test("truncated frame is rejected", () => {
    const good = encodeFrame({
      body: new Uint8Array([1, 2, 3]),
      epoch: 1,
      path: "x",
      type: "doc-sync",
    });
    expect(() => decodeFrame(good.slice(0, -2))).toThrow(EnvelopeError);
  });

  test("control with non-json payload is rejected", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_CONTROL);
    encoding.writeVarString(encoder, "not json {");
    expect(() => decodeFrame(encoding.toUint8Array(encoder))).toThrow(EnvelopeError);
  });

  test("control with a non-object payload is rejected", () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_CONTROL);
    encoding.writeVarString(encoder, '"just a string"');
    expect(() => decodeFrame(encoding.toUint8Array(encoder))).toThrow(EnvelopeError);
  });

  test("empty input is rejected", () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(EnvelopeError);
  });

  test("encoding an unknown frame shape is rejected", () => {
    expect(() => encodeFrame({ type: "bogus" } as unknown as CollabFrame)).toThrow(EnvelopeError);
  });
});
