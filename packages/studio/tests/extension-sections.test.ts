/**
 * Tests for src/settings/extension-sections.ts — deriving settings-modal registrations from the
 * extensions payload (deriveSettingsSection) and syncing them into the section registry
 * (syncExtensionSettingsSections): registration, re-sync unregistration of removed extensions, and
 * reset. The modal integration (nav position, contributed render) lives in settings-modal.test.ts;
 * the end-to-end parser parity in contributed-content-types.test.ts.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deriveSettingsSection,
  extensionSectionKeys,
  resetExtensionSettingsSections,
  syncExtensionSettingsSections,
} from "../src/settings/extension-sections";
import { closeSettingsModal, openSettingsModal } from "../src/settings/settings-modal";
import { refreshFormats } from "../src/format/format-host";
import { initLayers } from "../src/ui/layers";
import type { ExtensionContributionInfo, ExtensionsInfo } from "../src/types";

// ─── Environment setup ───────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

function navLabels(): (string | undefined)[] {
  const modal = (document.querySelector("#layer-modal") as HTMLElement).querySelector(
    ".settings-modal",
  );
  return [...modal!.querySelectorAll(".settings-nav-item")].map((b) => b.textContent?.trim());
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
});

afterEach(async () => {
  closeSettingsModal();
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

    openSettingsModal();
    await flush(4);
    expect(navLabels()).toContain("Guestbook");
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

    openSettingsModal();
    await flush(4);
    expect(navLabels()).not.toContain("Guestbook");
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
    // Opening the modal re-syncs against the CURRENT platform — with none, nothing comes back.
    refreshFormats();
    installMockPlatform();
    openSettingsModal();
    await flush(4);
    expect(navLabels()).not.toContain("Guestbook");
  });

  test("registered sections render through renderContributedSection with the live config", async () => {
    installMockPlatform({
      listExtensions: async () => extensionsWith([guestbookContribution]),
    });
    resetStudioState({ projectConfig: { guestbook: { moderation: true } } as unknown });
    await syncExtensionSettingsSections();
    openSettingsModal();
    await flush(4);
    const modal = (document.querySelector("#layer-modal") as HTMLElement).querySelector(
      ".settings-modal",
    )!;
    const nav = [...modal.querySelectorAll(".settings-nav-item")].find(
      (b) => b.textContent?.trim() === "Guestbook",
    )!;
    nav.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const contentEl = modal.querySelector(".settings-modal-content")!;
    expect(contentEl.querySelector(".settings-section-title")?.textContent).toBe("Guestbook");
    const check = contentEl.querySelector('[data-prop="moderation"] sp-checkbox');
    expect(check).not.toBeNull();
  });
});
