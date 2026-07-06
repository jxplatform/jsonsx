/** The interactive menu path for built-in templates: options 2-4 select a template variant. */
import { describe, expect, mock, test } from "bun:test";
import { basename, resolve } from "node:path";

// Answers in prompt order: name, description, url, template (3 = Mobile First), adapter.
const answers = ["", "Menu site", "", "3", "1"];

void mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    close: () => {},
    question: () => Promise.resolve(answers.shift() ?? ""),
  }),
}));

void mock.module("@jxsuite/starters", () => ({
  listStarters: () => [{ id: "restaurant", name: "Bistro & Café", tagline: "A menu-driven site." }],
}));

const generateProject = mock(() => Promise.resolve());
void mock.module("../generate", () => ({ generateProject }));

console.log = () => {};

process.argv = [process.argv[0] ?? "bun", "index.ts", "menu-site"];

const cliEntry = "../index";
const cliModule = (await import(cliEntry)) as { ready?: Promise<unknown> };
await cliModule.ready;

const destPath = resolve("menu-site");

describe("create-jxsuite CLI — built-in template from the menu", () => {
  test("selects the template variant and keeps the starter blank", () => {
    expect(generateProject).toHaveBeenCalledWith(destPath, {
      adapter: "static",
      description: "Menu site",
      name: basename(destPath),
      starter: "blank",
      template: "mobile-first",
      url: "",
    });
  });
});
