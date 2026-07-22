/**
 * Repository picker modal tests — drives the real picker through the layer system: repo list
 * rendering with badges, filtering, import success resolving the catalogue root key, the structured
 * not_jx_project failure staying inline, dismissal, and the Open Project mode (write-access
 * filtering, Jx-first ordering, install-App empty state).
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { RepoInfo } from "../src/types";

const {
  closeAddRepoModal,
  openAddRepoModal,
  openProjectPickerModal,
  platformSupportsAddRepo,
  platformUsesRepoPicker,
} = await import("../src/new-project/add-repo-modal");
const { hydrateAccountStatus, resetAccountStatus } = await import("../src/account-status");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

const REPOS: RepoInfo[] = [
  {
    defaultBranch: "main",
    fullName: "octocat/site",
    isJxProject: true,
    name: "site",
    owner: "octocat",
    permission: "admin",
    private: true,
  },
  {
    defaultBranch: "trunk",
    fullName: "acme/marketing",
    isJxProject: false,
    name: "marketing",
    owner: "acme",
    permission: "write",
    private: false,
  },
];

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll("#layer-modal .add-repo-row")] as HTMLButtonElement[];
}

function modal(): HTMLElement | null {
  return document.querySelector("#layer-modal .add-repo-modal");
}

function errorText(): string | null {
  return document.querySelector("#layer-modal .new-project-error")?.textContent?.trim() ?? null;
}

afterEach(() => {
  closeAddRepoModal();
  resetAccountStatus();
});

describe("platformSupportsAddRepo", () => {
  test("requires both listRepos and importProject", () => {
    installMockPlatform();
    expect(platformSupportsAddRepo()).toBe(false);
    installMockPlatform({ listRepos: () => Promise.resolve(REPOS) });
    expect(platformSupportsAddRepo()).toBe(false);
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    expect(platformSupportsAddRepo()).toBe(true);
  });
});

describe("platformUsesRepoPicker", () => {
  test("requires the repo-list marker on top of listRepos + importProject", () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    expect(platformUsesRepoPicker()).toBe(false);
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
      openProjectPicker: "repo-list",
    });
    expect(platformUsesRepoPicker()).toBe(true);
    // The marker alone is not enough without the backing capabilities.
    installMockPlatform({ openProjectPicker: "repo-list" });
    expect(platformUsesRepoPicker()).toBe(false);
  });
});

describe("openAddRepoModal", () => {
  test("lists repos with badges and filters by full name", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    expect(modal()).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("octocat/site");
    expect(rows()[0]!.textContent).toContain("Jx");
    expect(rows()[0]!.textContent).toContain("private");
    expect(rows()[1]!.textContent).toContain("trunk · write");

    const filter = document.querySelector("#layer-modal .add-repo-filter") as HTMLInputElement;
    filter.value = "acme";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("acme/marketing");

    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("importing a repo resolves with its catalogue root key", async () => {
    const importProject = mock((opts: { owner: string; name: string }) =>
      Promise.resolve({ root: `${opts.owner}/${opts.name}@main` }),
    );
    installMockPlatform({
      importProject: importProject as never,
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    rows()[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(importProject).toHaveBeenCalledWith({ name: "site", owner: "octocat" });
    expect(await promise).toEqual({ root: "octocat/site@main" });
    expect(modal()).toBeNull();
  });

  test("a not_jx_project failure stays inline and the picker remains open", async () => {
    installMockPlatform({
      importProject: () =>
        Promise.reject(
          Object.assign(new Error("acme/marketing has no readable project.json"), {
            code: "not_jx_project",
          }),
        ),
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    rows()[1]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(modal()).toBeTruthy();
    expect(errorText()).toContain("no readable project.json");

    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("a failed repo listing shows the error with an empty list", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "r" }),
      listRepos: () => Promise.reject(new Error("GitHub authorization expired")),
    });
    const promise = openAddRepoModal();
    await flush();
    expect(rows()).toHaveLength(0);
    expect(errorText()).toContain("GitHub authorization expired");
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("add mode shows read-only repos (no write filter)", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "r" }),
      listRepos: () => Promise.resolve([READ_ONLY_REPO]),
    });
    const promise = openAddRepoModal();
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("acme/docs");
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });
});

const READ_ONLY_REPO: RepoInfo = {
  defaultBranch: "main",
  fullName: "acme/docs",
  isJxProject: true,
  name: "docs",
  owner: "acme",
  permission: "read",
  private: false,
};

const UNTAGGED_WRITABLE_REPO: RepoInfo = {
  defaultBranch: "main",
  fullName: "acme/newsletter",
  isJxProject: false,
  name: "newsletter",
  owner: "acme",
  permission: "write",
  private: false,
};

describe("openProjectPickerModal", () => {
  test("shows only writable repos, Jx-tagged first, under the Open Project title", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve([UNTAGGED_WRITABLE_REPO, READ_ONLY_REPO, ...REPOS]),
      openProjectPicker: "repo-list",
    });
    const promise = openProjectPickerModal();
    await flush();
    const title = document.querySelector("#layer-modal .new-project-modal-title");
    expect(title?.textContent?.trim()).toBe("Open Project");
    const names = rows().map((row) => row.title);
    // Read-only acme/docs is absent; Jx-tagged octocat/site precedes the untagged writable repos.
    expect(names).toEqual(["octocat/site", "acme/newsletter", "acme/marketing"]);
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("selection imports the repo and resolves its catalogue root key", async () => {
    const importProject = mock((opts: { owner: string; name: string }) =>
      Promise.resolve({ root: `${opts.owner}/${opts.name}@main` }),
    );
    installMockPlatform({
      importProject: importProject as never,
      listRepos: () => Promise.resolve(REPOS),
      openProjectPicker: "repo-list",
    });
    const promise = openProjectPickerModal();
    await flush();
    rows()[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(importProject).toHaveBeenCalledWith({ name: "site", owner: "octocat" });
    expect(await promise).toEqual({ root: "octocat/site@main" });
  });

  test("an untagged repo's import failure stays inline", async () => {
    installMockPlatform({
      importProject: () =>
        Promise.reject(
          Object.assign(new Error("acme/newsletter has no readable project.json"), {
            code: "not_jx_project",
          }),
        ),
      listRepos: () => Promise.resolve([UNTAGGED_WRITABLE_REPO]),
      openProjectPicker: "repo-list",
    });
    const promise = openProjectPickerModal();
    await flush();
    rows()[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(modal()).toBeTruthy();
    expect(errorText()).toContain("no readable project.json");
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("repos without write access get the widen-access empty state", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "r" }),
      listRepos: () => Promise.resolve([READ_ONLY_REPO]),
      openProjectPicker: "repo-list",
    });
    const promise = openProjectPickerModal();
    await flush();
    expect(rows()).toHaveLength(0);
    const empty = document.querySelector("#layer-modal .add-repo-empty");
    expect(empty?.textContent).toContain("No repositories with write access");
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("no reachable repos prompts a GitHub App install link", async () => {
    installMockPlatform({
      getAccountStatus: () =>
        Promise.resolve({
          appInstallUrl: "https://github.com/apps/jx-suite/installations/new",
          installations: [],
        }),
      importProject: () => Promise.resolve({ root: "r" }),
      listRepos: () => Promise.resolve([]),
      openProjectPicker: "repo-list",
    });
    await hydrateAccountStatus();
    const promise = openProjectPickerModal();
    await flush();
    const link = document.querySelector("#layer-modal .add-repo-install") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toBe("https://github.com/apps/jx-suite/installations/new");
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });
});
