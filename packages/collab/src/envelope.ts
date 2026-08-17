/**
 * The binary wire envelope every Jx collab provider speaks: the Cloudflare platform DO, the
 * devserver endpoint in the server package, and the browser client. One WebSocket per project
 * carries every open document, multiplexed by path:
 *
 *     frame          := varUint frameType, body
 *     0 DOC_SYNC     := varString path, varUint docEpoch, varUint8Array y-protocols sync body
 *     1 AWARENESS    := varUint8Array y-protocols awareness update (project-scoped)
 *     2 DOC_CLOSE    := varString path                (client → server unsubscribe)
 *     3 CONTROL      := varString json                (see ControlMessage)
 *
 * `docEpoch` is the server-owned lifetime counter of a document's Y history. Out-of-band content
 * replacement (git discard/pull/rename, non-collab writes) bumps it; frames carrying a stale epoch
 * are dropped and answered with a `doc-reset` control message, upon which the client destroys its
 * Y.Doc and re-opens. The invariant "Y history is never deleted or replaced without an epoch bump"
 * is what prevents divergent-history duplicate-content merges.
 *
 * The layout above is what the `jx.collab.v1` WebSocket subprotocol names. A change that would make
 * a peer mis-parse a frame is a new token, not a silent edit here — see `negotiate.ts` for the bump
 * rule and for why the capability probe, not the socket, is where the two sides agree.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export { COLLAB_SUBPROTOCOL } from "./negotiate.ts";

export const FRAME_DOC_SYNC = 0;
export const FRAME_AWARENESS = 1;
export const FRAME_DOC_CLOSE = 2;
export const FRAME_CONTROL = 3;

export type CollabPermission = "admin" | "write" | "read";

/** JSON payloads of CONTROL frames. */
export type ControlMessage =
  /** Server → client on accept: the socket's identity and effective permission. */
  | {
      type: "hello";
      login: string;
      name?: string;
      avatarUrl?: string;
      color: string;
      permission: CollabPermission;
    }
  /** Client → server: subscribe to a document (the client's Y.Doc must start EMPTY). */
  | { type: "open"; path: string }
  /** Server → client: the room is ready at this epoch; sync follows. */
  | { type: "opened"; path: string; epoch: number }
  /** Server → client: the doc's history was replaced; destroy the local Y.Doc and re-open. */
  | { type: "doc-reset"; path: string; epoch: number }
  /** Client → server: persist this doc to durable storage now (Cmd+S). */
  | { type: "flush"; path: string }
  /** Server → client: the flush landed. */
  | { type: "flush-ack"; path: string }
  /**
   * Server → client: the room's unsaved-since-last-persist state changed (drives the Save
   * affordance). Room-level and authoritative: any peer's edit dirties the room for everyone; a
   * persist clears it for everyone. Sent to a newly-subscribing connection during the open
   * handshake so it learns the current state.
   */
  | { type: "doc-dirty"; path: string; dirty: boolean }
  /**
   * Server → client: a request was refused (codes: read-only, content-not-loaded, too-large,
   * rate-limited, binary-file, unknown-frame).
   */
  | { type: "error"; path?: string; code: string; message: string };

export type CollabFrame =
  | { type: "doc-sync"; path: string; epoch: number; body: Uint8Array }
  | { type: "awareness"; body: Uint8Array }
  | { type: "doc-close"; path: string }
  | { type: "control"; message: ControlMessage };

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export function encodeFrame(frame: CollabFrame): Uint8Array {
  const encoder = encoding.createEncoder();
  switch (frame.type) {
    case "doc-sync": {
      encoding.writeVarUint(encoder, FRAME_DOC_SYNC);
      encoding.writeVarString(encoder, frame.path);
      encoding.writeVarUint(encoder, frame.epoch);
      encoding.writeVarUint8Array(encoder, frame.body);
      break;
    }
    case "awareness": {
      encoding.writeVarUint(encoder, FRAME_AWARENESS);
      encoding.writeVarUint8Array(encoder, frame.body);
      break;
    }
    case "doc-close": {
      encoding.writeVarUint(encoder, FRAME_DOC_CLOSE);
      encoding.writeVarString(encoder, frame.path);
      break;
    }
    case "control": {
      encoding.writeVarUint(encoder, FRAME_CONTROL);
      encoding.writeVarString(encoder, JSON.stringify(frame.message));
      break;
    }
    default: {
      throw new EnvelopeError(`unknown-frame:${(frame as CollabFrame).type}`);
    }
  }
  return encoding.toUint8Array(encoder);
}

export function decodeFrame(data: Uint8Array): CollabFrame {
  try {
    const decoder = decoding.createDecoder(data);
    const frameType = decoding.readVarUint(decoder);
    switch (frameType) {
      case FRAME_DOC_SYNC: {
        const path = decoding.readVarString(decoder);
        const epoch = decoding.readVarUint(decoder);
        const body = decoding.readVarUint8Array(decoder);
        return { body, epoch, path, type: "doc-sync" };
      }
      case FRAME_AWARENESS: {
        return { body: decoding.readVarUint8Array(decoder), type: "awareness" };
      }
      case FRAME_DOC_CLOSE: {
        return { path: decoding.readVarString(decoder), type: "doc-close" };
      }
      case FRAME_CONTROL: {
        const message = JSON.parse(decoding.readVarString(decoder)) as ControlMessage;
        if (typeof message !== "object" || typeof message.type !== "string") {
          throw new EnvelopeError("malformed-control");
        }
        return { message, type: "control" };
      }
      default: {
        throw new EnvelopeError(`unknown-frame-type:${frameType}`);
      }
    }
  } catch (error) {
    if (error instanceof EnvelopeError) {
      throw error;
    }
    throw new EnvelopeError(
      `malformed-frame: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
