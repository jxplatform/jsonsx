/**
 * The --template flag path: a starter chosen on the command line skips the interactive template
 * prompt and is forwarded to generateProject.
 */
import { describe, expect, mock, test } from "bun:test";
import { basename, resolve } from "node:path";

const prompts: string[] = [];
// With --template supplied there is no template prompt: name, description, url, adapter.
const answers = ["", "Flag site", "https://flag.example", "1"];

void mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    close: () => {},
    question: (prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? "");
    },
  }),
}));

void mock.module("@jxsuite/starters", () => ({
  listStarters: () => [{ id: "restaurant", name: "Bistro & Café", tagline: "A menu-driven site." }],
}));

const generateProject = mock(() => Promise.resolve());
void mock.module("../generate", () => ({ generateProject }));

console.log = () => {};

process.argv = [process.argv[0] ?? "bun", "index.ts", "flag-site", "--template", "restaurant"];

const cliEntry = "../index";
const cliModule = (await import(cliEntry)) as { ready?: Promise<unknown> };
await cliModule.ready;

const destPath = resolve("flag-site");

describe("create-jxsuite CLI — --template flag", () => {
  test("skips the interactive template prompt", () => {
    expect(prompts).toHaveLength(4);
    expect(prompts).not.toContain("Template [1]: ");
  });

  test("forwards the chosen starter to generateProject", () => {
    expect(generateProject).toHaveBeenCalledWith(destPath, {
      adapter: "static",
      description: "Flag site",
      name: basename(destPath),
      starter: "restaurant",
      template: "blank",
      url: "https://flag.example",
    });
  });
});
