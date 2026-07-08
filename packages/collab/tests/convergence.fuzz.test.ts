/**
 * Convergence fuzz: N replicas each run random op scripts against their own current state, updates
 * are delivered in random interleavings, and every replica maintains a plain-JSON mirror through
 * the SAME inbound path the studio bridge uses (yEventsToDocOps fast path, diff-style fallback to
 * yDocToJson). Asserts, at every delivery and at quiescence: mirrors equal their Y trees, all
 * replicas converge, and the tree stays structurally valid. The failing seed prints for replay.
 */

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { JxMutableNode, JxPath } from "@jxsuite/schema/types";
import type { JxDocOp } from "../src/ops.ts";
import { applyDocOpToDoc, getNodeAtPath } from "../src/ops.ts";
import { applyDocOpsToY, LOCAL_ORIGIN, yEventsToDocOps } from "../src/op-bridge.ts";
import { seedStructure, yDocToJson } from "../src/schema.ts";

/** Deterministic LCG (no bitwise per house rules; modulus keeps it in float-exact range). */
function makeRng(seed: number) {
  let state = seed % 2_147_483_647;
  if (state <= 0) {
    state += 2_147_483_646;
  }
  return {
    int(maxExclusive: number): number {
      state = (state * 16_807) % 2_147_483_647;
      return state % maxExclusive;
    },
    pick<T>(items: readonly T[]): T {
      return items[this.int(items.length)]!;
    },
  };
}

type Rng = ReturnType<typeof makeRng>;

/** Every node path in the tree (paths address object nodes, not string children). */
function collectNodePaths(doc: JxMutableNode): JxPath[] {
  const paths: JxPath[] = [[]];
  const walk = (node: JxMutableNode, path: JxPath) => {
    if (!Array.isArray(node.children)) {
      return;
    }
    for (const [index, child] of node.children.entries()) {
      if (typeof child === "object" && child !== null) {
        const childPath = [...path, "children", index];
        paths.push(childPath);
        walk(child, childPath);
      }
    }
  };
  walk(doc, []);
  return paths;
}

const TAGS = ["div", "p", "span", "section", "h2"];
const KEYS = ["textContent", "style", "attributes", "$props"];

function randomNode(rng: Rng): JxMutableNode {
  const node: JxMutableNode = { tagName: rng.pick(TAGS) };
  if (rng.int(2) === 0) {
    node.textContent = `t${rng.int(1000)}`;
  }
  if (rng.int(3) === 0) {
    node.children = [{ tagName: rng.pick(TAGS), textContent: `c${rng.int(100)}` }];
  }
  return node;
}

/** One random op valid against the CURRENT doc state, or null when no target exists. */
function randomOp(rng: Rng, doc: JxMutableNode): JxDocOp | null {
  const paths = collectNodePaths(doc);
  const kind = rng.int(6);
  const parentPath = rng.pick(paths);
  const parent = getNodeAtPath(doc, parentPath);
  const children = Array.isArray(parent.children) ? parent.children : [];
  switch (kind) {
    case 0: {
      const node = rng.int(4) === 0 ? `s${rng.int(100)}` : randomNode(rng);
      return { index: rng.int(children.length + 1), node, op: "insert-child", parentPath };
    }
    case 1: {
      if (children.length === 0) {
        return null;
      }
      return { index: rng.int(children.length), op: "remove-child", parentPath };
    }
    case 2: {
      if (children.length === 0) {
        return null;
      }
      return {
        index: rng.int(children.length),
        node: randomNode(rng),
        op: "set-child",
        parentPath,
      };
    }
    case 3: {
      const path = rng.pick(paths);
      const key = rng.pick(KEYS);
      const value =
        rng.int(4) === 0
          ? undefined
          : key === "textContent"
            ? `v${rng.int(1000)}`
            : { [`k${rng.int(5)}`]: `v${rng.int(10)}` };
      return value === undefined
        ? { key, op: "set-key", path }
        : { key, op: "set-key", path, value };
    }
    case 4: {
      if (children.length === 0) {
        return null;
      }
      const toParentPath = rng.pick(paths);
      const fromIndex = rng.int(children.length);
      // Moving a node into its own subtree is invalid; regenerate as a same-parent move.
      const fromChildPath = [...parentPath, "children", fromIndex];
      const intoSelf =
        toParentPath.length >= fromChildPath.length &&
        fromChildPath.every((seg, i) => seg === toParentPath[i]);
      const target = intoSelf ? parentPath : toParentPath;
      const targetNode = getNodeAtPath(doc, target);
      const targetLen = Array.isArray(targetNode.children) ? targetNode.children.length : 0;
      const sameParent = target === parentPath;
      const maxIndex = sameParent ? Math.max(0, targetLen - 1) : targetLen;
      return {
        fromIndex,
        fromParentPath: parentPath,
        op: "move-child",
        toIndex: rng.int(maxIndex + 1),
        toParentPath: target,
      };
    }
    default: {
      const path = rng.pick(paths);
      return { key: "style", op: "set-key", path, value: { margin: `${rng.int(40)}px` } };
    }
  }
}

/** Structural validity: children are arrays of nodes/strings, no null/undefined holes. */
function assertValidTree(doc: JxMutableNode, seed: number) {
  const walk = (node: JxMutableNode) => {
    if (node.children === undefined) {
      return;
    }
    if (!Array.isArray(node.children)) {
      throw new TypeError(`seed ${seed}: children is not an array`);
    }
    for (const child of node.children) {
      if (child === null || child === undefined) {
        throw new TypeError(`seed ${seed}: null child`);
      }
      if (typeof child === "object") {
        walk(child);
      } else if (typeof child !== "string") {
        throw new TypeError(`seed ${seed}: unexpected child type ${typeof child}`);
      }
    }
  };
  walk(doc);
}

interface Replica {
  ydoc: Y.Doc;
  /** Plain-JSON mirror maintained through the bridge's inbound path. */
  mirror: JxMutableNode;
  /** Updates produced locally, not yet delivered to peers. */
  outbox: Uint8Array[];
}

function makeReplica(base: Y.Doc): Replica {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(base));
  const replica: Replica = { mirror: yDocToJson(ydoc), outbox: [], ydoc };
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL_ORIGIN) {
      replica.outbox.push(update);
    }
  });
  ydoc.getMap("structure").observeDeep((events, transaction) => {
    if (transaction.origin === LOCAL_ORIGIN) {
      return;
    }
    const ops = yEventsToDocOps(events as unknown as Y.YEvent<never>[]);
    if (ops === null) {
      // The bridge's diff fallback lands the tab on the Y state; model that directly.
      replica.mirror = yDocToJson(ydoc);
      return;
    }
    try {
      for (const op of ops) {
        applyDocOpToDoc(replica.mirror, op);
      }
    } catch {
      replica.mirror = yDocToJson(ydoc);
    }
  });
  return replica;
}

function runFuzz(seed: number, rounds: number) {
  const rng = makeRng(seed);
  const base = new Y.Doc();
  seedStructure(base, {
    children: [
      { tagName: "h1", textContent: "Fuzz" },
      { children: [{ tagName: "p", textContent: "x" }], tagName: "section" },
    ],
    tagName: "div",
  });
  const replicas = [makeReplica(base), makeReplica(base), makeReplica(base)];

  for (let round = 0; round < rounds; round++) {
    // Each replica performs a burst of local ops (mirror first — like the tab — then Y).
    for (const replica of replicas) {
      const burst = rng.int(3) + 1;
      for (let i = 0; i < burst; i++) {
        const op = randomOp(rng, replica.mirror);
        if (!op) {
          continue;
        }
        applyDocOpToDoc(replica.mirror, op);
        applyDocOpsToY(replica.ydoc, [op], LOCAL_ORIGIN);
      }
      expect(yDocToJson(replica.ydoc)).toEqual(replica.mirror);
    }
    // Random partial delivery.
    for (let deliveries = rng.int(4); deliveries > 0; deliveries--) {
      const from = rng.pick(replicas);
      const to = rng.pick(replicas);
      if (from === to || from.outbox.length === 0) {
        continue;
      }
      for (const update of from.outbox) {
        Y.applyUpdate(to.ydoc, update, `peer`);
      }
      expect(yDocToJson(to.ydoc)).toEqual(to.mirror);
    }
  }

  // Quiescence: full pairwise state exchange.
  for (const from of replicas) {
    for (const to of replicas) {
      if (from !== to) {
        Y.applyUpdate(
          to.ydoc,
          Y.encodeStateAsUpdate(from.ydoc, Y.encodeStateVector(to.ydoc)),
          "peer",
        );
      }
    }
  }
  const reference = yDocToJson(replicas[0]!.ydoc);
  for (const replica of replicas) {
    expect(yDocToJson(replica.ydoc)).toEqual(reference);
    expect(replica.mirror).toEqual(reference);
    assertValidTree(replica.mirror, seed);
  }
}

describe("three-replica convergence fuzz", () => {
  const seeds = [7, 42, 1337, 90_210, 424_242];
  for (const seed of seeds) {
    test(`seed ${seed} converges with faithful mirrors`, () => {
      try {
        runFuzz(seed, 12);
      } catch (error) {
        console.error(`fuzz failure — replay with seed ${seed}`);
        throw error;
      }
    });
  }
});
