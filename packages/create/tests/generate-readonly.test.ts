/**
 * Regression coverage for scaffolding out of a READ-ONLY template store, and for the rollback that
 * runs when a scaffold throws partway through.
 *
 * `fs.cp` reproduces the SOURCE's permission bits on the destination, so a starter shipped from a
 * store where every path is 444/555 — which is what /nix/store is, by construction — produced a
 * read-only project, and the generator then died on its own next write: `EACCES: permission denied,
 * open '<dest>/project.json'`. The suites beside this one cannot see it: their fixtures are built
 * by the test process at the default umask, so their sources are writable.
 *
 * The failure also left the half-written tree behind, which turned the user's retry into `Directory
 * "<dest>" is not empty` — an error describing the debris rather than the cause.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STAMP = Date.now();
const FIXTURE = resolve(tmpdir(), `jx-readonly-fixture-${STAMP}`);
const BROKEN = resolve(tmpdir(), `jx-readonly-broken-${STAMP}`);
const OUTSIDE = resolve(tmpdir(), `jx-readonly-outside-${STAMP}`);
const TMP = resolve(tmpdir(), `jx-create-readonly-test-${STAMP}`);

// Stand in for @jxsuite/starters: "fixture" is a well-formed read-only starter; "broken" is one
// Whose project.json cannot be parsed, which is how the rollback path is reached.
void mock.module("@jxsuite/starters", () => ({
  getStarterDir: (id: string) => {
    if (id === "fixture") {
      return FIXTURE;
    }
    if (id === "broken") {
      return BROKEN;
    }
    throw new Error(`Unknown starter: "${id}"`);
  },
}));

const { generateProject } = await import("../generate");

/**
 * Apply `dirMode`/`fileMode` to every directory and file under `dir`, depth-first so a directory is
 * still searchable while its children are being walked. Symlinks are left alone — `chmodSync`
 * follows them, and these fixtures point deliberately outside the tree.
 */
function chmodTree(dir: string, dirMode: number, fileMode: number) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      chmodTree(full, dirMode, fileMode);
      chmodSync(full, dirMode);
    } else {
      chmodSync(full, fileMode);
    }
  }
}

/** Lock a fixture down to exactly what a store path looks like. */
const lockdown = (dir: string) => {
  chmodTree(dir, 0o555, 0o444);
  chmodSync(dir, 0o555);
};

/**
 * Widen a tree back to writable. Every teardown must run this BEFORE `rmSync`: unlinking an entry
 * needs write permission on the directory holding it, so a 555 tree cannot be deleted and the test
 * would otherwise leak a directory the runner itself cannot remove.
 */
const unlock = (dir: string) => {
  if (!existsSync(dir)) {
    return;
  }
  chmodSync(dir, 0o755);
  chmodTree(dir, 0o755, 0o644);
};

/** The permission bits of `p`, following symlinks (nothing here is called on a link). */
// oxlint-disable-next-line no-bitwise -- st_mode is a bitfield; masking is how permissions are read
const permsOf = (p: string) => statSync(p).mode & 0o777;

/** Whether `p` carries the owner-write bit — the one thing the fix is responsible for. */
// oxlint-disable-next-line no-bitwise -- st_mode is a bitfield; masking is how a bit is tested
const isWritable = (p: string) => (permsOf(p) & 0o200) !== 0;

/**
 * Every real (non-symlink) path under `dir`. Links are omitted because a symlink's own mode is
 * meaningless on Linux — it is always 777 — and `statSync` on one reports its TARGET, which is the
 * very file this fix must leave alone.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) {
      walk(full, out);
    }
  }
  return out;
}

beforeAll(() => {
  mkdirSync(join(FIXTURE, "pages"), { recursive: true });
  mkdirSync(join(FIXTURE, "content", "posts"), { recursive: true });
  writeFileSync(
    join(FIXTURE, "project.json"),
    JSON.stringify({ name: "Atrium", style: {}, url: "https://fixture.example" }),
  );
  writeFileSync(join(FIXTURE, "package.json"), JSON.stringify({ name: "atrium" }));
  writeFileSync(join(FIXTURE, "pages", "index.md"), "# Home\n");
  writeFileSync(join(FIXTURE, "content", "posts", "first.md"), "# First\n");
  writeFileSync(join(FIXTURE, "setup.sh"), "#!/bin/sh\necho hi\n");

  // A symlink pointing out of the starter tree. Chmod follows symlinks, so a walk that does not
  // Skip them would widen a file the scaffolder has no business touching.
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(OUTSIDE, "secret.txt"), "not ours");
  chmodSync(join(OUTSIDE, "secret.txt"), 0o444);
  symlinkSync(join(OUTSIDE, "secret.txt"), join(FIXTURE, "link.txt"));

  lockdown(FIXTURE);
  // Stamped AFTER the lockdown, which flattens every file to 0o444: a template file that is
  // Deliberately executable proves the fix ADDS owner-write rather than assigning a flat 0o644.
  chmodSync(join(FIXTURE, "setup.sh"), 0o555);

  mkdirSync(BROKEN, { recursive: true });
  writeFileSync(join(BROKEN, "project.json"), "{ this is not json");
  lockdown(BROKEN);
});

afterEach(() => {
  unlock(TMP);
  rmSync(TMP, { force: true, recursive: true });
});

afterAll(() => {
  for (const dir of [FIXTURE, BROKEN, OUTSIDE]) {
    unlock(dir);
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("generateProject — read-only template store", () => {
  test("scaffolds from a read-only starter and re-stamps project.json", async () => {
    await generateProject(TMP, { name: "Language Demo", starter: "fixture" });

    // The regression itself: this write is the statement that threw EACCES, so the starter's own
    // Name surviving is exactly the symptom the user saw.
    const project = JSON.parse(readFileSync(join(TMP, "project.json"), "utf8"));
    expect(project.name).toBe("Language Demo");
    expect(project.name).not.toBe("Atrium");

    // The rebuilt package.json is the write immediately after it.
    const pkg = JSON.parse(readFileSync(join(TMP, "package.json"), "utf8"));
    expect(pkg.name).toBe("language-demo");
    expect(readFileSync(join(TMP, "content", "posts", "first.md"), "utf8")).toBe("# First\n");
  });

  test("leaves every file and directory in the new project writable", async () => {
    await generateProject(TMP, { name: "Writable", starter: "fixture" });

    const notWritable = walk(TMP).filter((p) => !isWritable(p));
    expect(notWritable).toEqual([]);
    // The scaffolded root is only writable because mkdir made it; the copied tree is the risk.
    expect(permsOf(join(TMP, "content", "posts"))).toBe(0o755);
  });

  test("adds owner-write without dropping an executable bit", async () => {
    await generateProject(TMP, { name: "Exec", starter: "fixture" });

    expect(permsOf(join(TMP, "setup.sh"))).toBe(0o755);
  });

  test("does not follow a symlink pointing out of the tree", async () => {
    await generateProject(TMP, { name: "Linked", starter: "fixture" });

    expect(permsOf(join(OUTSIDE, "secret.txt"))).toBe(0o444);
  });

  test("produces a writable project on the blank path too", async () => {
    await generateProject(TMP, { name: "Blank Writable" });

    const notWritable = walk(TMP).filter((p) => !isWritable(p));
    expect(notWritable).toEqual([]);
  });
});

describe("generateProject — rollback on failure", () => {
  test("removes the directory it created", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(generateProject(TMP, { name: "Doomed", starter: "broken" })).rejects.toThrow();

    // Without the rollback this directory survives, and the retry the user reaches for reports
    // `Directory "…" is not empty` instead of the real failure.
    expect(existsSync(TMP)).toBe(false);
  });

  test("empties, but keeps, a directory that already existed", async () => {
    mkdirSync(TMP, { recursive: true });

    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(generateProject(TMP, { name: "Doomed", starter: "broken" })).rejects.toThrow();

    expect(existsSync(TMP)).toBe(true);
    expect(readdirSync(TMP)).toEqual([]);
  });

  test("never deletes a directory that already had content", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "keep-me.txt"), "user data");

    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(generateProject(TMP, { name: "Doomed", starter: "broken" })).rejects.toThrow(
      `Directory "${TMP}" is not empty`,
    );

    // The guard rejects before anything is created, so the rollback must never run here — this is
    // The property that keeps an over-eager cleanup away from a user's files.
    expect(readFileSync(join(TMP, "keep-me.txt"), "utf8")).toBe("user data");
  });
});
