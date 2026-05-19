import { describe, test, expect } from "bun:test";
import { createDesktopPlatform } from "../src/chromium/platform";

// ─── createDesktopPlatform ──────────────────────────────────────────────────
// The chromium platform adapter depends on WebSocket in the browser.
// We test the structure and non-network aspects here.

describe("chromium platform structure", () => {
  // We can't fully instantiate because WebSocket isn't available in Bun test
  // but we can verify the module exports correctly and the factory shape

  test("module exports createDesktopPlatform function", () => {
    expect(typeof createDesktopPlatform).toBe("function");
  });
});

// For integration testing of the WebSocket platform, we test via the RPC server
// in chromium-rpc.test.ts which spins up the actual server and connects.
