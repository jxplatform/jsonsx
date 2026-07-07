import { describe, expect, test } from "bun:test";
import { loadProjectConfig } from "../src/site/site-loader";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_siteloader");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
}

function cleanup() {
  rmSync(FIXTURES, { force: true, recursive: true });
}

describe("loadProjectConfig", () => {
  test("throws when project.json contains invalid JSON", () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), "{ invalid json }", "utf8");
      expect(() => loadProjectConfig(FIXTURES)).toThrow("Failed to parse project config");
    } finally {
      cleanup();
    }
  });

  test("throws when project.json is missing", () => {
    setup();
    try {
      expect(() => loadProjectConfig(FIXTURES)).toThrow("project.json not found");
    } finally {
      cleanup();
    }
  });

  test("throws when project.json is not an object", () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), '"a string"', "utf8");
      expect(() => loadProjectConfig(FIXTURES)).toThrow("expected a JSON object");
    } finally {
      cleanup();
    }
  });

  test("loads valid project.json with defaults", () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), JSON.stringify({ name: "Test" }), "utf8");
      const { config, configPath, projectRoot } = loadProjectConfig(FIXTURES);
      expect(config.name).toBe("Test");
      expect(configPath).toContain("project.json");
      expect(projectRoot).toBe(FIXTURES);
    } finally {
      cleanup();
    }
  });

  test("defaults images.service to build", () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), JSON.stringify({ name: "Test" }), "utf8");
      const { config } = loadProjectConfig(FIXTURES);
      expect(config.images.service).toBe("build");
    } finally {
      cleanup();
    }
  });

  test("throws on unknown images.service", () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "project.json"),
        JSON.stringify({ images: { service: "imgix" }, name: "Test" }),
        "utf8",
      );
      expect(() => loadProjectConfig(FIXTURES)).toThrow('Unknown images.service "imgix"');
    } finally {
      cleanup();
    }
  });

  test("accepts the cloudflare service with any adapter (cdn-cgi URLs are markup-only)", () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "project.json"),
        JSON.stringify({
          build: { adapter: "node" },
          images: { service: "cloudflare" },
          name: "Test",
        }),
        "utf8",
      );
      const { config } = loadProjectConfig(FIXTURES);
      expect(config.images.service).toBe("cloudflare");
    } finally {
      cleanup();
    }
  });

  test("preserves $media, style and state without shallow-merging", () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "project.json"),
        JSON.stringify({
          $media: { "--md": "(min-width: 768px)" },
          name: "Test",
          state: { count: { default: 0 } },
          style: { "--bg": "#000" },
        }),
        "utf8",
      );
      const { config } = loadProjectConfig(FIXTURES);
      expect(config.$media).toEqual({ "--md": "(min-width: 768px)" });
      expect(config.style).toEqual({ "--bg": "#000" });
      expect(config.state).toEqual({ count: { default: 0 } });
    } finally {
      cleanup();
    }
  });

  test("throws on unknown build adapter", () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "project.json"),
        JSON.stringify({ build: { adapter: "deno" }, name: "Test" }),
        "utf8",
      );
      expect(() => loadProjectConfig(FIXTURES)).toThrow('Unknown build adapter "deno"');
    } finally {
      cleanup();
    }
  });

  test('normalizes adapter "static" (the Settings no-adapter choice) away', () => {
    setup();
    try {
      writeFileSync(
        join(FIXTURES, "project.json"),
        JSON.stringify({ build: { adapter: "static" }, name: "Test" }),
        "utf8",
      );
      const { config } = loadProjectConfig(FIXTURES);
      expect(config.build.adapter).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
