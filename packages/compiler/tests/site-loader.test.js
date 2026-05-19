import { describe, test, expect } from "bun:test";
import { loadProjectConfig } from "../src/site/site-loader.js";
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
});
