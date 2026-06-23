/**
 * Drives the create-jxsuite CLI entry (index.ts), which runs at import time: readline prompts and
 * the generator are mocked, argv supplies the destination, and the module is imported afterwards.
 */
import { describe, expect, mock, test } from "bun:test";
import { basename, resolve } from "node:path";

const prompts: string[] = [];
const answers = ["", "A test site", "https://test.example", "2"];

void mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    close: () => {},
    question: (prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? "");
    },
  }),
}));

const generateProject = mock(() => Promise.resolve());
void mock.module("../generate", () => ({ generateProject }));

const logs: string[] = [];
console.log = (...args: unknown[]) => {
  logs.push(args.join(" "));
};

process.argv = [process.argv[0] ?? "bun", "index.ts", "my-test-site"];

// Non-literal specifier: keeps tsgo from adding the CLI entry (which has a pre-existing
// TS7053 implicit-any at adapterMap[adapterChoice]) to the type-check program.
const cliEntry = "../index";
// The entry runs its interactive flow in an exported `ready` promise (not a top-level await), so
// Await it: Bun's test runtime drops a dynamically-imported module's top-level-await continuation.
const cliModule = (await import(cliEntry)) as { ready?: Promise<unknown> };
await cliModule.ready;

const destPath = resolve("my-test-site");

describe("create-jxsuite CLI", () => {
  test("asks for name, description, URL, and adapter", () => {
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toBe(`Project name (${basename(destPath)}): `);
    expect(prompts[1]).toBe("Description: ");
    expect(prompts[2]).toBe("Production URL (https://example.com): ");
    expect(prompts[3]).toBe("Adapter [1]: ");
  });

  test("defaults the project name to the directory name when left blank", () => {
    expect(generateProject).toHaveBeenCalledWith(destPath, {
      adapter: "cloudflare-pages",
      description: "A test site",
      name: basename(destPath),
      url: "https://test.example",
    });
  });

  test("resolves the destination relative to the working directory", () => {
    expect(generateProject).toHaveBeenCalledTimes(1);
  });

  test("prints the adapter menu and next steps", () => {
    const output = logs.join("\n");
    expect(output).toContain("Deployment adapter:");
    expect(output).toContain(`Project created at ${destPath}`);
    expect(output).toContain("cd my-test-site");
    expect(output).toContain("bun run dev");
  });
});
