import { describe, test, expect } from "bun:test";
import { loadProjectConfig } from "../src/site/site-loader";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_siteloader");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
}

function cleanup() {
  rmSync(FIXTURES, { recursive: true, force: true });
}

describe("loadProjectConfig", () => {
  test("throws when project.json contains invalid JSON", () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "project.json"), "{ invalid json }", "utf8");
      expect(() => loadProjectConfig(FIXTURES)).toThrow("Invalid JSON in");
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
      expect(() => loadProjectConfig(FIXTURES)).toThrow("must be a JSON object");
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
        JSON.stringify({ name: "Test", images: { service: "imgix" } }),
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
          name: "Test",
          images: { service: "cloudflare" },
          build: { adapter: "node" },
        }),
        "utf8",
      );
      const { config } = loadProjectConfig(FIXTURES);
      expect(config.images.service).toBe("cloudflare");
    } finally {
      cleanup();
    }
  });
});
