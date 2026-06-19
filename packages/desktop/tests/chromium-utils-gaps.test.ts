// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Configurable fake D-Bus session bus ───────────────────────────────────
//
// `openFileDialog` talks to the freedesktop FileChooser portal over D-Bus.
// We mock `dbus-ts` so each test can script the portal's behavior: what
// OpenFile returns, and how the Request object fires its "Response" event.

type ResponseHandler = (response: number, results: unknown) => void;

interface FakeConfig {
  openFileError?: Error;
  openFileHandle?: string;
  respond?: (fire: ResponseHandler) => void;
}

let config: FakeConfig = {};
let endCalls = 0;
let openFileArgs: unknown[] = [];
let requestPath: string | null = null;

const fakeBus = {
  connection: {
    end: () => {
      endCalls += 1;
    },
  },
  getInterface: (_service: string, path: string, iface: string) => {
    if (iface === "org.freedesktop.portal.FileChooser") {
      return Promise.resolve({
        OpenFile: (...args: unknown[]) => {
          openFileArgs = args;
          if (config.openFileError) {
            return Promise.reject(config.openFileError);
          }
          return Promise.resolve([config.openFileHandle ?? "/org/fdo/portal/request/1"]);
        },
      });
    }
    // Org.freedesktop.portal.Request
    requestPath = path;
    return Promise.resolve({
      on: (event: string, handler: ResponseHandler) => {
        if (event === "Response") {
          config.respond?.(handler);
        }
      },
    });
  },
};

void mock.module("dbus-ts", () => ({
  sessionBus: () => Promise.resolve(fakeBus),
}));

const { openFileDialog } = await import("../src/chromium/utils");

beforeEach(() => {
  config = {};
  endCalls = 0;
  openFileArgs = [];
  requestPath = null;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("openFileDialog (chromium / D-Bus portal)", () => {
  test("resolves the selected file path from nested array response format", async () => {
    config.respond = (fire) => {
      fire(0, [["uris", ["as", ["file:///home/user/projects/site/project.json"]]]]);
    };
    const result = await openFileDialog();
    expect(result).toBe("/home/user/projects/site/project.json");
  });

  test("resolves the selected file path from object response format", async () => {
    config.respond = (fire) => {
      fire(0, { uris: ["file:///tmp/demo/project.json"] });
    };
    const result = await openFileDialog();
    expect(result).toBe("/tmp/demo/project.json");
  });

  test("passes title, modal options and a handle token to OpenFile", async () => {
    config.respond = (fire) => fire(0, { uris: ["file:///a/b.json"] });
    await openFileDialog();
    expect(openFileArgs[0]).toBe("");
    expect(openFileArgs[1]).toBe("Open project.json");
    const options = openFileArgs[2] as [string, [string, unknown]][];
    const keys = options.map(([key]) => key);
    expect(keys).toEqual(["directory", "modal", "handle_token", "filters"]);
    const tokenEntry = options.find(([key]) => key === "handle_token");
    expect(tokenEntry?.[1][0]).toBe("s");
    expect(String(tokenEntry?.[1][1])).toStartWith("bun_");
  });

  test("listens on the Request object at the handle returned by OpenFile", async () => {
    config.openFileHandle = "/org/fdo/portal/request/custom_42";
    config.respond = (fire) => fire(0, { uris: ["file:///a/b.json"] });
    await openFileDialog();
    expect(requestPath).toBe("/org/fdo/portal/request/custom_42");
  });

  test("returns null when the user cancels (non-zero response code)", async () => {
    config.respond = (fire) => fire(1, { uris: ["file:///ignored.json"] });
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("returns null when the response contains no uris", async () => {
    config.respond = (fire) => fire(0, { uris: [] });
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("returns null when the response results are an empty object", async () => {
    config.respond = (fire) => fire(0, {});
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("returns null when the uri is not a parseable URL", async () => {
    config.respond = (fire) => fire(0, { uris: ["not a valid url"] });
    const result = await openFileDialog();
    expect(result).toBeNull();
  });

  test("closes the bus connection after a successful selection", async () => {
    config.respond = (fire) => fire(0, { uris: ["file:///x/y.json"] });
    await openFileDialog();
    expect(endCalls).toBe(1);
  });

  test("closes the bus connection even when OpenFile fails", async () => {
    config.openFileError = new Error("portal unavailable");
    await expect(openFileDialog()).rejects.toThrow("portal unavailable");
    expect(endCalls).toBe(1);
  });

  test("fires asynchronously after registration still resolves the path", async () => {
    config.respond = (fire) => {
      setTimeout(() => fire(0, { uris: ["file:///delayed/project.json"] }), 5);
    };
    const result = await openFileDialog();
    expect(result).toBe("/delayed/project.json");
  });
});
