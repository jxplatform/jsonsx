/**
 * The one failure the Studio Backend Protocol has always published a shape for — `gitPull`'s `409
 * {conflicts}` — and never produced.
 *
 * Two defects had to line up for that. `runGit` threw `stderr || "git exited with N"`, and a
 * conflicting `git pull` writes every `CONFLICT (…)` line to **stdout** while leaving stderr empty
 * — so the failure arrived contentless. Then the pull handler had no conflict branch at all, so it
 * reached the catch-all as a 500 and Studio told the user the backend had broken rather than that
 * their branch and the remote had both touched the same files.
 *
 * A real git repository with a real remote, because the whole defect lives in which stream git
 * chose. A mock would have been written against the wrong one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStudioApi } from "../src/studio-api";

let base = "";
let local = "";

function git(cwd: string, args: string) {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

async function pull(): Promise<Response> {
  const url = "http://localhost/__studio/git/pull";
  const res = await handleStudioApi(new Request(url, { method: "POST" }), new URL(url), local);
  if (!res) {
    throw new Error("no response from the studio API");
  }
  return res;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "jx-git-conflict-"));
  const remote = join(base, "remote");
  local = join(base, "local");
  mkdirSync(remote, { recursive: true });

  git(remote, "init -q -b main");
  git(remote, "config user.email test@test.com");
  git(remote, "config user.name Test");
  writeFileSync(join(remote, "shared.txt"), "original\n");
  writeFileSync(join(remote, "other.txt"), "original\n");
  git(remote, "add .");
  git(remote, "commit -qm initial");

  execSync(`git clone -q "${remote}" "${local}"`, { stdio: "pipe" });
  git(local, "config user.email test@test.com");
  git(local, "config user.name Test");
  git(local, "config pull.rebase false");

  // Both sides edit the same two files, so the pull cannot fast-forward.
  writeFileSync(join(remote, "shared.txt"), "remote\n");
  writeFileSync(join(remote, "other.txt"), "remote\n");
  git(remote, "commit -qam remote-side");

  writeFileSync(join(local, "shared.txt"), "local\n");
  writeFileSync(join(local, "other.txt"), "local\n");
  git(local, "commit -qam local-side");
});

afterAll(() => {
  rmSync(base, { force: true, recursive: true });
});

describe("POST /__studio/git/pull with conflicting changes", () => {
  test("answers the documented 409, naming every conflicting file", async () => {
    const res = await pull();
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/problem+json");

    const body = (await res.json()) as { conflicts: string[]; detail: string; type: string };
    expect(body.type).toBe("https://jxsuite.com/problems/conflict");
    // The paths are the only part of this a user can act on.
    expect(body.conflicts.toSorted()).toEqual(["other.txt", "shared.txt"]);
    expect(body.detail).toContain("2 file(s)");
  });

  /*
   * A pull that fails for any OTHER reason must not be reported as a conflict. The conflict branch
   * rethrows when it finds no conflicting paths, so an unrelated failure keeps its own status.
   */
  test("a non-conflict pull failure is not mislabelled", async () => {
    const orphan = join(base, "orphan");
    mkdirSync(orphan, { recursive: true });
    git(orphan, "init -q -b main");
    git(orphan, "config user.email test@test.com");
    git(orphan, "config user.name Test");
    writeFileSync(join(orphan, "a.txt"), "a\n");
    git(orphan, "add .");
    git(orphan, "commit -qm only");

    const url = "http://localhost/__studio/git/pull";
    const res = await handleStudioApi(new Request(url, { method: "POST" }), new URL(url), orphan);
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as { detail: string; type: string };
    expect(body.type).toBe("https://jxsuite.com/problems/internal-error");
    // And the message is not empty, which is the other half of the old defect.
    expect(body.detail.trim()).not.toBe("");
  });
});
