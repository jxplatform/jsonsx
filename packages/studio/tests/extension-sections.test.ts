/**
 * Tests for src/settings/extension-sections.ts — deriving section registrations from the extensions
 * payload (deriveSettingsSection) and syncing them into the section registry
 * (syncExtensionSettingsSections): registration, re-sync unregistration of removed extensions,
 * coalescing of concurrent syncs, and reset. The document integration (nav position, contributed
 * render) lives in settings-document.test.ts; the end-to-end parser parity in
 * contributed-content-types.test.ts.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deriveSettingsSection,
  extensionSectionKeys,
  extensionSectionsReady,
  resetExtensionSettingsSections,
  syncExtensionSettingsSections,
} from "../src/settings/extension-sections";
import { detachSettingsPane, renderSettingsPane } from "../src/panels/settings-pane";
import { setSettingsSection, settingsSectionKeys } from "../src/settings/section-registry";
import "../src/settings/settings-document";
import { refreshFormats } from "../src/format/format-host";
import type { ExtensionContributionInfo, ExtensionsInfo } from "../src/types";

// ─── Environment setup ───────────────────────────────────────────────────────

let host: HTMLElement;

/** Mount the settings document on a throwaway host and read its inner nav. */
async function navLabels(): Promise<(string | undefined)[]> {
  renderSettingsPane(host);
  await flush();
  return [...host.querySelectorAll(".settings-nav-item")].map((b) => b.textContent?.trim());
}

function body(): HTMLElement {
  return host.querySelector(".settings-doc-content") as HTMLElement;
}

const guestbookContribution: ExtensionContributionInfo = {
  className: "Guestbook",
  entrySchema: {
    properties: { moderation: { type: "boolean" }, table: { type: "string" } },
    type: "object",
  },
  project: { key: "guestbook", title: "Guestbook" },
  studio: { settings: { layout: "form", order: 70 } },
};

function extensionsWith(contributions: ExtensionContributionInfo[]): ExtensionsInfo[] {
  return [
    {
      contributions,
      name: "@acme/jx-guestbook",
      specifier: "@acme/jx-guestbook",
    },
  ];
}

beforeEach(() => {
  resetExtensionSettingsSections();
  refreshFormats();
  resetStudioState({ projectConfig: { guestbook: {} } as unknown });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  detachSettingsPane();
  host.remove();
  setSettingsSection("overview");
  await flush();
  resetExtensionSettingsSections();
});

// ─── deriveSettingsSection ───────────────────────────────────────────────────

describe("deriveSettingsSection", () => {
  test("returns null without a $studio.settings block", () => {
    expect(deriveSettingsSection({ className: "X", project: { key: "x" }, studio: null })).toBe(
      null,
    );
    expect(
      deriveSettingsSection({ className: "X", project: { key: "x" }, studio: { icon: "i" } }),
    ).toBe(null);
  });

  test("form layout keeps the whole section schema and defaults order to 100", () => {
    const derived = deriveSettingsSection({
      className: "Guestbook",
      entrySchema: { properties: { table: { type: "string" } }, type: "object" },
      project: { key: "guestbook", title: "Guestbook" },
      studio: { settings: {} },
    })!;
    expect(derived.key).toBe("guestbook");
    expect(derived.label).toBe("Guestbook");
    expect(derived.order).toBe(100);
    expect(derived.contribution.settings).toEqual({});
    expect(derived.contribution.entrySchema).toEqual({
      properties: { table: { type: "string" } },
      type: "object",
    });
  });

  test("map layout narrows to the section schema's additionalProperties", () => {
    const derived = deriveSettingsSection({
      className: "Content",
      entrySchema: {
        additionalProperties: { properties: { source: { type: "string" } }, type: "object" },
        type: "object",
      },
      project: { key: "content" },
      studio: {
        settings: {
          entry: { newEntry: { source: "./content/${key}/" } },
          icon: "sp-icon-view-grid",
          label: "Content Types",
          layout: "map",
          order: 50,
        },
      },
    })!;
    expect(derived.label).toBe("Content Types");
    expect(derived.icon).toBe("sp-icon-view-grid");
    expect(derived.order).toBe(50);
    expect(derived.contribution.entrySchema).toEqual({
      properties: { source: { type: "string" } },
      type: "object",
    });
    expect(derived.contribution.settings.entry?.newEntry).toEqual({
      source: "./content/${key}/",
    });
  });

  test("map layout without a usable additionalProperties degrades to an empty schema", () => {
    const derived = deriveSettingsSection({
      className: "Content",
      entrySchema: { additionalProperties: true, type: "object" },
      project: { key: "content" },
      studio: { settings: { layout: "map" } },
    })!;
    expect(derived.contribution.entrySchema).toEqual({});

    const noSchema = deriveSettingsSection({
      className: "Content",
      entrySchema: null,
      project: { key: "content" },
      studio: { settings: { layout: "map" } },
    })!;
    expect(noSchema.contribution.entrySchema).toEqual({});
  });

  test("label falls back settings.label → project.title → key", () => {
    const base: ExtensionContributionInfo = {
      className: "X",
      project: { key: "things" },
      studio: { settings: {} },
    };
    expect(deriveSettingsSection(base)!.label).toBe("things");
    expect(
      deriveSettingsSection({ ...base, project: { key: "things", title: "Things!" } })!.label,
    ).toBe("Things!");
    expect(
      deriveSettingsSection({
        ...base,
        studio: { settings: { label: "Label wins" } },
      })!.label,
    ).toBe("Label wins");
  });
});

// ─── syncExtensionSettingsSections ───────────────────────────────────────────

describe("syncExtensionSettingsSections", () => {
  test("registers a section per $studio.settings contribution via platform.listExtensions", async () => {
    installMockPlatform({
      listExtensions: async () => extensionsWith([guestbookContribution]),
    });
    await syncExtensionSettingsSections();
    expect(extensionSectionKeys()).toEqual(["guestbook"]);
    expect(await navLabels()).toContain("Guestbook");
  });

  test("concurrent callers share one run — the deep-link race, at its source", async () => {
    let loads = 0;
    installMockPlatform({
      listExtensions: async () => {
        loads += 1;
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        return extensionsWith([guestbookContribution]);
      },
    });
    const first = syncExtensionSettingsSections();
    const second = syncExtensionSettingsSections();
    expect(second).toBe(first);
    expect(extensionSectionsReady()).toBe(first);
    await Promise.all([first, second]);
    expect(loads).toBe(1);
    expect(extensionSectionKeys()).toEqual(["guestbook"]);
    // With nothing in flight, readiness is immediate rather than the last run's promise.
    await extensionSectionsReady();
  });

  test("contributions without settings are skipped", async () => {
    installMockPlatform({
      listExtensions: async () =>
        extensionsWith([{ className: "Silent", project: { key: "silent" }, studio: null }]),
    });
    await syncExtensionSettingsSections();
    expect(extensionSectionKeys()).toEqual([]);
  });

  test("a re-sync unregisters sections whose extension disappeared", async () => {
    installMockPlatform({
      listExtensions: async () => extensionsWith([guestbookContribution]),
    });
    await syncExtensionSettingsSections();
    expect(extensionSectionKeys()).toEqual(["guestbook"]);

    // The project dropped the extension: a fresh payload without the contribution.
    refreshFormats();
    installMockPlatform({ listExtensions: async () => [] });
    await syncExtensionSettingsSections();
    expect(extensionSectionKeys()).toEqual([]);
    expect(await navLabels()).not.toContain("Guestbook");
  });

  test("platforms without listExtensions register nothing", async () => {
    installMockPlatform();
    await syncExtensionSettingsSections();
    expect(extensionSectionKeys()).toEqual([]);
  });

  test("resetExtensionSettingsSections unregisters everything it added", async () => {
    installMockPlatform({
      listExtensions: async () => extensionsWith([guestbookContribution]),
    });
    await syncExtensionSettingsSections();
    resetExtensionSettingsSections();
    expect(extensionSectionKeys()).toEqual([]);
    // A re-sync against the CURRENT platform — with none, nothing comes back.
    refreshFormats();
    installMockPlatform();
    await syncExtensionSettingsSections();
    expect(await navLabels()).not.toContain("Guestbook");
  });

  test("registered sections render through renderContributedSection with the live config", async () => {
    installMockPlatform({
      listExtensions: async () => extensionsWith([guestbookContribution]),
    });
    resetStudioState({ projectConfig: { guestbook: { moderation: true } } as unknown });
    await syncExtensionSettingsSections();
    expect(settingsSectionKeys()).toContain("guestbook");
    setSettingsSection("guestbook");
    await navLabels();
    expect(body().querySelector(".settings-section-title")?.textContent).toBe("Guestbook");
    expect(body().querySelector('[data-prop="moderation"] sp-checkbox')).not.toBeNull();
  });
});
