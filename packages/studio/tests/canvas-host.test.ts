import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { canvasHost, isIframeCanvas, setCanvasHostOverride } from "../src/canvas/canvas-host";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };

afterEach(() => {
  setCanvasHostOverride(null);
  happyDOM.setURL("http://localhost:3000/");
});

describe("isIframeCanvas", () => {
  test("is unconditionally true — the iframe is the only canvas now", () => {
    happyDOM.setURL("http://localhost:3000/");
    expect(isIframeCanvas()).toBe(true);
    // The legacy host machinery is retained only for the patch-wire test's override; it no longer
    // Influences whether the iframe canvas is used.
    happyDOM.setURL("http://localhost:3000/?canvasHost=legacy-div");
    expect(isIframeCanvas()).toBe(true);
    setCanvasHostOverride("legacy-div");
    expect(isIframeCanvas()).toBe(true);
  });
});

describe("canvasHost (legacy override plumbing, retained for the patch-wire test)", () => {
  test("the override forces the value and clearing falls back to default", () => {
    setCanvasHostOverride("iframe");
    expect(canvasHost()).toBe("iframe");
    setCanvasHostOverride(null);
    expect(canvasHost()).toBe("legacy-div");
  });

  test("?canvasHost=iframe selects the iframe host", () => {
    happyDOM.setURL("http://localhost:3000/?canvasHost=iframe");
    expect(canvasHost()).toBe("iframe");
  });

  test("an invalid ?canvasHost value falls back to the default", () => {
    happyDOM.setURL("http://localhost:3000/?canvasHost=bogus");
    expect(canvasHost()).toBe("legacy-div");
  });

  test("the override takes precedence over the URL param", () => {
    happyDOM.setURL("http://localhost:3000/?canvasHost=iframe");
    setCanvasHostOverride("legacy-div");
    expect(canvasHost()).toBe("legacy-div");
  });
});
