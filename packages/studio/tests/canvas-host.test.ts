import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { canvasHost, isIframeCanvas, setCanvasHostOverride } from "../src/canvas/canvas-host";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };

afterEach(() => {
  setCanvasHostOverride(null);
  happyDOM.setURL("http://localhost:3000/");
});

describe("canvasHost", () => {
  test("defaults to legacy-div with no override or URL param", () => {
    happyDOM.setURL("http://localhost:3000/");
    expect(canvasHost()).toBe("legacy-div");
    expect(isIframeCanvas()).toBe(false);
  });

  test("the override forces the value and clearing falls back to default", () => {
    setCanvasHostOverride("iframe");
    expect(canvasHost()).toBe("iframe");
    expect(isIframeCanvas()).toBe(true);
    setCanvasHostOverride(null);
    expect(canvasHost()).toBe("legacy-div");
  });

  test("?canvasHost=iframe selects the iframe host", () => {
    happyDOM.setURL("http://localhost:3000/?canvasHost=iframe");
    expect(canvasHost()).toBe("iframe");
    expect(isIframeCanvas()).toBe(true);
  });

  test("?canvasHost=legacy-div is honored explicitly", () => {
    happyDOM.setURL("http://localhost:3000/?canvasHost=legacy-div");
    expect(canvasHost()).toBe("legacy-div");
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
