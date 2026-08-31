/**
 * Tests for resolveDefaultPlatform (src/platforms/default-platform.ts): it picks the cloud adapter
 * when the cloud shell published a `window.__jxCloud` signal, else the dev-server adapter. This is
 * what keeps the cloud adapter — and its collab client's single yjs — inside the studio bundle.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveDefaultPlatform } from "../src/platforms/default-platform";
import type { CloudProject } from "../src/platforms/cloud";

const g = globalThis as unknown as { __jxCloud?: { project: CloudProject | null } };

afterEach(() => {
  delete g.__jxCloud;
});

describe("resolveDefaultPlatform", () => {
  test("returns the dev-server adapter when no cloud signal is present", () => {
    delete g.__jxCloud;
    expect(resolveDefaultPlatform().id).toBe("devserver");
  });

  test("returns the cloud adapter bound to the signalled project", () => {
    g.__jxCloud = { project: { owner: "acme", repo: "site", branch: "main" } };
    const platform = resolveDefaultPlatform();
    expect(platform.id).toBe("cloud");
    // The root key, branch included — the identity Recent and the catalogue both address a project by.
    expect(platform.projectRoot).toBe("acme/site@main");
  });

  test("returns the cloud adapter for the project-less hub (null project)", () => {
    g.__jxCloud = { project: null };
    const platform = resolveDefaultPlatform();
    expect(platform.id).toBe("cloud");
    expect(platform.projectRoot).toBe("");
  });
});
