/**
 * Host-level edge cases driven through raw {@link RoomSocket} frames (no client): malformed frames,
 * doc-sync against unknown rooms or stale epochs, unknown y-protocols message types, malformed
 * awareness payloads, and opens abandoned while their room is still seeding.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as encoding from "lib0/encoding";
import { createCollabHost } from "../src/ws-room.ts";
import type { CollabHost, RoomSocket } from "../src/ws-room.ts";
import { decodeFrame, encodeFrame } from "../src/envelope.ts";
import type { CollabFrame, ControlMessage } from "../src/envelope.ts";
import type { CollabIdentity } from "../src/provider.ts";

const IDENTITY: CollabIdentity = { color: "#4f9cf9", login: "octocat", permission: "write" };

/** A server-side socket that decodes every outbound frame into an inspectable log. */
function recordingSocket(): { socket: RoomSocket; frames: CollabFrame[] } {
  const frames: CollabFrame[] = [];
  return {
    frames,
    socket: {
      close: () => {},
      send: (data) => {
        frames.push(decodeFrame(data));
      },
    },
  };
}

function controls(frames: CollabFrame[]): ControlMessage[] {
  return frames.flatMap((frame) => (frame.type === "control" ? [frame.message] : []));
}

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

const cleanups: (() => void)[] = [];

function makeHost(loadSource: (path: string) => Promise<string | null>): CollabHost {
  const host = createCollabHost({ loadSource });
  cleanups.push(() => host.destroy());
  return host;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("malformed input", () => {
  test("an undecodable frame answers with an unknown-frame error", () => {
    const host = makeHost(() => Promise.resolve("x"));
    const { frames, socket } = recordingSocket();
    const conn = host.connect(socket, IDENTITY);
    conn.handleMessage(new Uint8Array([9]));
    expect(controls(frames).at(-1)).toEqual({
      code: "unknown-frame",
      message: "Malformed frame",
      type: "error",
    });
  });

  test("a malformed awareness payload is dropped without relaying", () => {
    const host = makeHost(() => Promise.resolve("x"));
    const sender = recordingSocket();
    const receiver = recordingSocket();
    const conn = host.connect(sender.socket, IDENTITY);
    host.connect(receiver.socket, { color: "#fff", login: "peer", permission: "write" });
    const before = receiver.frames.length;
    // Announces one clientID, then truncates before its clock — the tracking decode throws.
    conn.handleMessage(encodeFrame({ body: new Uint8Array([1]), type: "awareness" }));
    expect(receiver.frames.length).toBe(before);
  });
});

describe("doc-sync guards", () => {
  test("doc-sync for a never-opened path answers doc-reset at the known epoch", () => {
    const host = makeHost(() => Promise.resolve("x"));
    const { frames, socket } = recordingSocket();
    const conn = host.connect(socket, IDENTITY);
    conn.handleMessage(
      encodeFrame({ body: new Uint8Array([0]), epoch: 0, path: "a.json", type: "doc-sync" }),
    );
    expect(controls(frames).at(-1)).toEqual({ epoch: 0, path: "a.json", type: "doc-reset" });
  });

  test("doc-sync at a stale epoch answers doc-reset", async () => {
    const host = makeHost(() => Promise.resolve("x"));
    const { frames, socket } = recordingSocket();
    const conn = host.connect(socket, IDENTITY);
    conn.handleMessage(encodeFrame({ message: { path: "a.json", type: "open" }, type: "control" }));
    await settle();
    expect(controls(frames).some((message) => message.type === "opened")).toBe(true);
    conn.handleMessage(
      encodeFrame({ body: new Uint8Array([0]), epoch: 7, path: "a.json", type: "doc-sync" }),
    );
    expect(controls(frames).at(-1)).toEqual({ epoch: 0, path: "a.json", type: "doc-reset" });
  });

  test("an unknown y-protocols message type inside doc-sync is dropped", async () => {
    const host = makeHost(() => Promise.resolve("x"));
    const { frames, socket } = recordingSocket();
    const conn = host.connect(socket, IDENTITY);
    conn.handleMessage(encodeFrame({ message: { path: "a.json", type: "open" }, type: "control" }));
    await settle();
    const body = encoding.createEncoder();
    encoding.writeVarUint(body, 42);
    const before = frames.length;
    conn.handleMessage(
      encodeFrame({
        body: encoding.toUint8Array(body),
        epoch: 0,
        path: "a.json",
        type: "doc-sync",
      }),
    );
    // No reply and no error: the frame is silently ignored.
    expect(frames.length).toBe(before);
  });
});

describe("opens abandoned mid-seed", () => {
  test("a connection that closes while its room seeds never subscribes", async () => {
    let release: (value: string | null) => void = () => {};
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const host = makeHost(() => gate);
    const { frames, socket } = recordingSocket();
    const conn = host.connect(socket, IDENTITY);
    conn.handleMessage(encodeFrame({ message: { path: "a.json", type: "open" }, type: "control" }));
    conn.close();
    release("seeded");
    await settle();
    expect(controls(frames).some((message) => message.type === "opened")).toBe(false);
    expect(host.subscriberCount("a.json")).toBe(0);
    // The room itself finished seeding — only the subscription was abandoned.
    expect(host.sourceOf("a.json")).toBe("seeded");
  });

  test("a room reset while its open is still seeding abandons the stale open", async () => {
    let release: (value: string | null) => void = () => {};
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const host = makeHost(() => gate);
    const { frames, socket } = recordingSocket();
    const conn = host.connect(socket, IDENTITY);
    conn.handleMessage(encodeFrame({ message: { path: "a.json", type: "open" }, type: "control" }));
    // Out-of-band replacement lands before the seed resolves: the room this open created is gone.
    host.resetDoc("a.json");
    release("late");
    await settle();
    expect(controls(frames).some((message) => message.type === "opened")).toBe(false);
    expect(host.subscriberCount("a.json")).toBe(0);
    expect(host.sourceOf("a.json")).toBeNull();
  });
});
