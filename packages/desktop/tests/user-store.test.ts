/**
 * Tests for src/user-store.ts — the shared user-level JSON store primitive.
 *
 * The three properties here are the ones no consumer exercises in ordinary single-window use, and
 * each of them is a defect the stores this replaced actually had: an interrupted write leaving torn
 * JSON, a store keeping a world-readable mode forever, and two concurrent read-modify-writes each
 * reading the same base so the second dropped the first's edit.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readJsonStore, readStringStore, updateStore, writeStore } from "../src/user-store";

const DIR = mkdtempSync(join(process.env.TMPDIR || "/tmp", "jx-user-store-"));

function storeFile(name = "store.json"): string {
  return join(DIR, name);
}

beforeEach(() => {
  for (const entry of readdirSync(DIR)) {
    rmSync(join(DIR, entry), { force: true, recursive: true });
  }
});

afterAll(() => {
  rmSync(DIR, { force: true, recursive: true });
});

describe("readStringStore", () => {
  test("returns {} for a missing file", async () => {
    expect(await readStringStore(storeFile())).toEqual({});
  });

  test("returns {} for torn or non-object JSON", async () => {
    writeFileSync(storeFile(), '{"a": "1', "utf8");
    expect(await readStringStore(storeFile())).toEqual({});
    writeFileSync(storeFile(), '["nope"]', "utf8");
    expect(await readStringStore(storeFile())).toEqual({});
    writeFileSync(storeFile(), "null", "utf8");
    expect(await readStringStore(storeFile())).toEqual({});
  });

  test("drops non-string values rather than coercing them", async () => {
    writeFileSync(storeFile(), JSON.stringify({ n: 3, nested: { a: 1 }, ok: "yes" }), "utf8");
    expect(await readStringStore(storeFile())).toEqual({ ok: "yes" });
  });
});

describe("readJsonStore", () => {
  test("returns the parsed value when accept admits it", async () => {
    writeFileSync(storeFile(), JSON.stringify([1, 2]), "utf8");
    const accept = (v: unknown): v is number[] => Array.isArray(v);
    expect(await readJsonStore(storeFile(), [] as number[], accept)).toEqual([1, 2]);
  });

  test("falls back when the file is missing or accept refuses", async () => {
    const accept = (v: unknown): v is number[] => Array.isArray(v);
    expect(await readJsonStore(storeFile(), [7], accept)).toEqual([7]);
    writeFileSync(storeFile(), JSON.stringify({ not: "an array" }), "utf8");
    expect(await readJsonStore(storeFile(), [7], accept)).toEqual([7]);
  });
});

describe("atomicity and permissions", () => {
  test("writeStore round-trips and leaves no temp file behind", async () => {
    await writeStore(storeFile(), { a: "1" });
    const written = readFileSync(storeFile(), "utf8");
    expect(JSON.parse(written)).toEqual({ a: "1" });
    expect(readdirSync(DIR).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  test("creates missing parent directories", async () => {
    const nested = join(DIR, "a", "b", "store.json");
    await writeStore(nested, { deep: "yes" });
    const written = readFileSync(nested, "utf8");
    expect(JSON.parse(written)).toEqual({ deep: "yes" });
  });

  /**
   * `writeFile`'s `mode` applies only when it CREATES the file, so a store that arrived
   * world-readable stayed that way through every later write. Renaming a fresh inode into place is
   * what makes the 0600 promise hold for a file that already exists.
   */
  test("repairs the mode of an existing world-readable store", async () => {
    if (process.platform === "win32") {
      return;
    }
    writeFileSync(storeFile(), "{}", { mode: 0o644 });
    chmodSync(storeFile(), 0o644);
    await writeStore(storeFile(), { a: "1" });
    // oxlint-disable-next-line no-bitwise -- masking the permission bits out of st_mode
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600);
  });
});

describe("the per-path lock", () => {
  /**
   * The defect: a read-modify-write that released between the halves. Two of these each read the
   * same empty base, and the second overwrote the first's key.
   */
  test("concurrent updates to one file compose instead of overwriting", async () => {
    await Promise.all(
      ["a", "b", "c"].map((key) =>
        updateStore(storeFile(), readStringStore, (current) => ({ ...current, [key]: key })),
      ),
    );
    expect(await readStringStore(storeFile())).toEqual({ a: "a", b: "b", c: "c" });
  });

  test("updateStore answers with the store as it then stands", async () => {
    await updateStore(storeFile(), readStringStore, () => ({ a: "1" }));
    const result = await updateStore(storeFile(), readStringStore, (c) => ({ ...c, b: "2" }));
    expect(result).toEqual({ a: "1", b: "2" });
  });

  /** A rejected update must not strand every write queued behind it. */
  test("a failed update does not poison the chain", async () => {
    await updateStore(storeFile(), readStringStore, () => ({ a: "1" }));
    let failure: unknown;
    try {
      await updateStore(storeFile(), readStringStore, () => {
        throw new Error("mutate failed");
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect((failure as Error).message).toBe("mutate failed");
    await updateStore(storeFile(), readStringStore, (c) => ({ ...c, b: "2" }));
    expect(await readStringStore(storeFile())).toEqual({ a: "1", b: "2" });
  });

  /** The lock is per PATH — two different stores must not serialize behind each other. */
  test("different files do not block each other", async () => {
    await Promise.all([
      updateStore(storeFile("one.json"), readStringStore, () => ({ which: "one" })),
      updateStore(storeFile("two.json"), readStringStore, () => ({ which: "two" })),
    ]);
    expect(await readStringStore(storeFile("one.json"))).toEqual({ which: "one" });
    expect(await readStringStore(storeFile("two.json"))).toEqual({ which: "two" });
  });
});
