/**
 * The --template flag path for built-in template ids: a template id wins over the starter lookup
 * and is forwarded to generateProject.
 */
import { describe, expect, mock, test } from "bun:test";
import { basename, resolve } from "node:path";

const prompts: string[] = [];
// With --template supplied there is no template prompt: name, description, url, adapter.
const answers = ["", "App site", "https://app.example", "1"];

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

process.argv = [process.argv[0] ?? "bun", "index.ts", "app-site", "--template", "mobile-app"];

const cliEntry = "../index";
const cliModule = (await import(cliEntry)) as { ready?: Promise<unknown> };
await cliModule.ready;

const destPath = resolve("app-site");

describe("create-jxsuite CLI — --template with a built-in id", () => {
  test("skips the interactive template prompt", () => {
    expect(prompts).toHaveLength(4);
    expect(prompts).not.toContain("Template [1]: ");
  });

  test("forwards the built-in template id to generateProject", () => {
    expect(generateProject).toHaveBeenCalledWith(destPath, {
      adapter: "static",
      description: "App site",
      name: basename(destPath),
      starter: "blank",
      template: "mobile-app",
      url: "https://app.example",
    });
  });
});
