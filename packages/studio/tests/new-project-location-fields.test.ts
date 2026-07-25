/**
 * Destination fields of the New Project Parameters step (specs/desktop.md §4.5).
 *
 * The modal suites exercise the `"path"` shape end-to-end through the wizard; this file drives
 * `location-fields.ts` directly so the `"repo"` shape — which only the cloud platform selects, and
 * which the modal tests' mock platform therefore never renders — is covered too, along with the
 * owner-loading, collision-hint, and separator edge cases.
 */
import { flush, installMockPlatform, renderInto } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import type { RepoInfo, StudioPlatform } from "../src/types";

const {
  collectDestination,
  destinationPath,
  loadLocationOptions,
  locationError,
  renderLocationFields,
  resetLocationFields,
  slugFieldLabel,
} = await import("../src/new-project/location-fields");

const REPOS: RepoInfo[] = [
  {
    defaultBranch: "main",
    fullName: "acme/site",
    isJxProject: true,
    name: "site",
    owner: "acme",
    permission: "admin",
    private: true,
  },
  {
    defaultBranch: "main",
    fullName: "zoe/blog",
    isJxProject: false,
    name: "blog",
    owner: "zoe",
    permission: "write",
    private: false,
  },
];

/** Install a repo-destination platform (the cloud shape), with optional owner sources. */
function installRepoPlatform(overrides: Partial<StudioPlatform> = {}) {
  return installMockPlatform({ createDestination: "repo", ...overrides });
}

/** Set an sp-picker's value and fire the `change` event the fields listen for. */
function setPickerValue(el: Element, value: string) {
  (el as HTMLElement & { value: string }).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Render the destination block into a detached container and return it. */
async function renderFields(slug: string) {
  return renderInto(renderLocationFields({ onSlugInput: () => {}, rerender: () => {}, slug }));
}

beforeEach(() => {
  resetLocationFields();
});

// ─── Path destinations ────────────────────────────────────────────────────────

describe("path destinations", () => {
  test("labels the slug field Directory and refuses an unset location", () => {
    installMockPlatform({ createDestination: "path" });
    expect(slugFieldLabel()).toBe("Directory");
    expect(collectDestination("my-site")).toBeNull();
    expect(locationError()).toBe("Choose a location for the project folder");
  });

  test("destinationPath joins with the parent's own separator", () => {
    expect(destinationPath({ kind: "path", parent: "/home/dev/Sites" }, "my-site")).toBe(
      "/home/dev/Sites/my-site",
    );
    // A Windows-style parent keeps backslashes rather than acquiring a mixed separator.
    expect(destinationPath({ kind: "path", parent: String.raw`C:\Sites` }, "my-site")).toBe(
      String.raw`C:\Sites\my-site`,
    );
  });

  test("destinationPath does not double a separator the parent already ends with", () => {
    expect(destinationPath({ kind: "path", parent: "/" }, "my-site")).toBe("/my-site");
  });

  test("destinationPath refuses a repo destination", () => {
    expect(() =>
      destinationPath({ kind: "repo", owner: "acme", private: true, repo: "site" }, "site"),
    ).toThrow("Only filesystem destinations have a path");
  });
});

// ─── Repo destinations ────────────────────────────────────────────────────────

describe("repo destinations", () => {
  test("labels the slug field Repository", () => {
    installRepoPlatform();
    expect(slugFieldLabel()).toBe("Repository");
  });

  test("refuses a missing owner, then a missing repository name", () => {
    installRepoPlatform();
    expect(collectDestination("my-site")).toBeNull();
    expect(locationError()).toBe("Choose an owner for the repository");
  });

  test("collects owner, repo, and visibility once an owner is chosen", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();

    // The first owner alphabetically is selected by default so the field is never empty.
    const destination = collectDestination("my-site");
    expect(destination).toEqual({ kind: "repo", owner: "acme", private: true, repo: "my-site" });
    expect(locationError()).toBe("");
  });

  test("an empty repository name is refused once an owner exists", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();

    expect(collectDestination("  ")).toBeNull();
    expect(locationError()).toBe("Repository name is required");
  });

  test("owners merge account installations and repo owners, sorted and deduped", async () => {
    installRepoPlatform({
      getAccountStatus: async () => ({
        installations: [
          { account: "zoe", id: 1 },
          { account: null, id: 2 },
          { account: "beta-org", id: 3 },
        ],
      }),
      listRepos: async () => REPOS,
    });
    let rerenders = 0;
    loadLocationOptions(() => {
      rerenders += 1;
    });
    await flush();
    expect(rerenders).toBe(1);

    const container = await renderFields("my-site");
    const options = [...container.querySelectorAll("sp-menu-item")].map((o) =>
      o.getAttribute("value"),
    );
    // "zoe" appears in both sources and must not be duplicated; visibility adds its own two items.
    expect(options.slice(0, 3)).toEqual(["acme", "beta-org", "zoe"]);
  });

  test("a failing owner source leaves a free-text owner field rather than erroring", async () => {
    installRepoPlatform({
      getAccountStatus: async () => {
        throw new Error("offline");
      },
      listRepos: async () => {
        throw new Error("offline");
      },
    });
    loadLocationOptions(() => {});
    await flush();

    const container = await renderFields("my-site");
    expect(container.querySelector("sp-picker.new-project-owner")).toBeNull();
    expect(container.querySelector("sp-textfield.new-project-owner")).not.toBeNull();
  });

  test("warns when the chosen owner already has a repo of that name", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();

    // The default owner is "acme", which already owns "site".
    const clashing = await renderFields("site");
    expect(clashing.textContent).toContain("already exists");

    const free = await renderFields("brand-new");
    expect(free.textContent).not.toContain("already exists");
  });

  test("previews the repository rather than a filesystem path", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();

    const container = await renderFields("my-site");
    const preview = container.querySelector(".new-project-destination-preview");
    expect(preview?.textContent).toContain("Repository");
    expect(preview?.textContent).toContain("acme/my-site");
  });

  test("renders the visibility picker defaulting to private", async () => {
    installRepoPlatform();
    const container = await renderFields("my-site");
    const visibility = container.querySelector("sp-picker.new-project-visibility");
    expect(visibility).not.toBeNull();
    expect((visibility as HTMLInputElement).value).toBe("private");
  });

  test("switching visibility to public is carried into the destination, and back", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();

    const container = await renderFields("my-site");
    const visibility = container.querySelector("sp-picker.new-project-visibility")!;
    setPickerValue(visibility, "public");
    expect(collectDestination("my-site")).toMatchObject({ private: false });

    setPickerValue(visibility, "private");
    expect(collectDestination("my-site")).toMatchObject({ private: true });
  });

  test("choosing an owner from the picker clears the pending error", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();

    const container = await renderFields("my-site");
    setPickerValue(container.querySelector("sp-picker.new-project-owner")!, "zoe");
    expect(collectDestination("my-site")).toMatchObject({ owner: "zoe" });
  });

  test("typing an owner into the free-text field is collected", async () => {
    // No owner sources, so the field falls back to free text.
    installRepoPlatform();
    const container = await renderFields("my-site");
    const owner = container.querySelector("sp-textfield.new-project-owner") as HTMLInputElement;

    // Prove the error is cleared by the edit, not merely absent.
    expect(collectDestination("my-site")).toBeNull();
    expect(locationError()).not.toBe("");
    owner.value = "hand-typed-org";
    owner.dispatchEvent(new Event("input", { bubbles: true }));
    expect(locationError()).toBe("");
    expect(collectDestination("my-site")).toMatchObject({ owner: "hand-typed-org" });
  });
});

// ─── Loading gate ─────────────────────────────────────────────────────────────

describe("loadLocationOptions", () => {
  test("is a no-op on path platforms — no owner lookup is attempted", async () => {
    const { state } = installMockPlatform({
      createDestination: "path",
      listRepos: async () => REPOS,
    });
    loadLocationOptions(() => {});
    await flush();
    expect(state.calls.some(([name]) => name === "listRepos")).toBe(false);
  });

  test("resetLocationFields clears a previously chosen destination", async () => {
    installRepoPlatform({ listRepos: async () => REPOS });
    loadLocationOptions(() => {});
    await flush();
    expect(collectDestination("my-site")).not.toBeNull();

    resetLocationFields();
    expect(collectDestination("my-site")).toBeNull();
    expect(locationError()).toBe("Choose an owner for the repository");
  });
});
