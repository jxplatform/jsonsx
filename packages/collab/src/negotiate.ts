/**
 * WebSocket subprotocol negotiation for the collab socket (RFC 6455 §1.9, §4.2.2).
 *
 * **The token names the wire envelope, not the package.** `jx.collab.v1` means "I speak the frame
 * layout `envelope.ts` documents". There is one token per envelope **major**, and the rule for
 * bumping it is narrow on purpose: bump when {@link decodeFrame} would _mis-parse_ a peer's frame —
 * a field reordered, a type widened, a length prefix changed. **Do not bump for a new frame type.**
 * Both halves already skip a frame type they do not know, so a v1 peer and a v1-plus-one-frame peer
 * interoperate; bumping there would refuse a room that would have worked.
 *
 * **Why the capability probe does the negotiating.** RFC 6455 §4.1 requires a client that offered
 * subprotocols and received no echo to _fail the connection_, and browsers enforce it. So a new
 * Studio that unconditionally offered `jx.collab.v1` would lose collab entirely against an older
 * dev server — a regression caused by the fix. The probe already exists, already returns a version
 * the client discards, and runs before the socket: it is the one place the client can learn what
 * the server speaks without risking the handshake. Hence {@link negotiateCollab}, which turns a
 * probe body into the list to offer — empty against a server that advertises nothing.
 *
 * **Nothing here may go in the `hello` control message.** That arrives after the socket is up and
 * after frames may already have been exchanged, which is too late to prevent the divergent-history
 * merge `schema.ts` warns about. Negotiation has to conclude before a byte of document state
 * moves.
 *
 * This module imports nothing, deliberately: the Studio platform adapters read it eagerly, before
 * the dynamic import that pulls in Yjs, so it must not drag the CRDT into the initial bundle.
 */

/** The subprotocol token for the envelope in `envelope.ts`. One token per envelope major. */
export const COLLAB_SUBPROTOCOL = "jx.collab.v1";

/** What the client should do with the socket, given what the server advertised. */
export interface CollabNegotiation {
  /**
   * The subprotocols to offer as `Sec-WebSocket-Protocol`. **Empty means offer none**, which is the
   * correct answer against a server that advertises none: an offer it cannot echo would fail the
   * handshake outright, where offering nothing connects exactly as it does today.
   */
  offer: string[];
  /**
   * Non-null when the peers cannot interoperate: the server advertised subprotocols and none of
   * them is one we speak. The client must not connect — the string says which side speaks what, so
   * the degradation is legible rather than a silent solo session.
   */
  refused: string | null;
}

/**
 * Decide what to offer, from the body of a `GET /__studio/collab` capability probe.
 *
 * @param {unknown} probe The parsed probe body, or null if it did not parse as JSON.
 * @returns {CollabNegotiation}
 */
export function negotiateCollab(probe: unknown): CollabNegotiation {
  if (probe === null || typeof probe !== "object") {
    // A 200 that is not a JSON object: pre-negotiation server. Connect as before, offering nothing.
    return { offer: [], refused: null };
  }
  const body = probe as { collab?: unknown; protocols?: unknown };
  if (body.collab === false) {
    return { offer: [], refused: "This server has collaboration disabled." };
  }
  const { protocols } = body;
  if (!Array.isArray(protocols) || protocols.length === 0) {
    // A server that predates negotiation. It would echo nothing, so we must offer nothing.
    return { offer: [], refused: null };
  }
  if (protocols.includes(COLLAB_SUBPROTOCOL)) {
    return { offer: [COLLAB_SUBPROTOCOL], refused: null };
  }
  const theirs = protocols.filter((p) => typeof p === "string").join(", ") || "none";
  return {
    offer: [],
    refused: `This server speaks collab envelope ${theirs}; this editor speaks ${COLLAB_SUBPROTOCOL}.`,
  };
}

/**
 * The subprotocols a client offered, from its `Sec-WebSocket-Protocol` request header.
 *
 * RFC 6455 §4.1 allows the field to be split across several header lines and comma-separated within
 * one; `Headers.get` already joins repeats with `, `, so one split covers both spellings.
 *
 * @param {string | null} header
 * @returns {string[]}
 */
export function offeredSubprotocols(header: string | null): string[] {
  if (!header) {
    return [];
  }
  return header
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

/** What the server should do with an upgrade, given the client's offer. */
export interface SubprotocolAnswer {
  /** The token to echo in the 101 response, or null to echo nothing. */
  echo: string | null;
  /** Non-null when the handshake must be refused instead of upgraded. */
  reject: string | null;
}

/**
 * Choose the subprotocol to echo (RFC 6455 §4.2.2 step 4).
 *
 * Three cases, and the middle one is the one that is easy to get wrong:
 *
 * - **No offer** — an older client. Upgrade and echo nothing; it is not expecting an echo, and
 *   refusing it would break every Studio built before this shipped.
 * - **An offer we speak** — echo exactly that token. Echoing a token the client did not offer is
 *   itself a protocol violation, so the echo is always a member of the offer.
 * - **An offer we do not speak** — refuse. This is the whole point: two peers whose envelopes
 *   disagree about merge granularity (see `collab.md` §3.1) must not end up in one room, and a
 *   refused handshake is a far better outcome than a divergent-history merge.
 *
 * @param {string[]} offered
 * @returns {SubprotocolAnswer}
 */
export function selectSubprotocol(offered: string[]): SubprotocolAnswer {
  if (offered.length === 0) {
    return { echo: null, reject: null };
  }
  if (offered.includes(COLLAB_SUBPROTOCOL)) {
    return { echo: COLLAB_SUBPROTOCOL, reject: null };
  }
  return {
    echo: null,
    reject: `No supported collab subprotocol offered (this server speaks ${COLLAB_SUBPROTOCOL}).`,
  };
}
