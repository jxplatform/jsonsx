/**
 * Tests for src/resize-edges.ts — window resize edge handles for the desktop shell.
 *
 * The module mounts eight edge/corner handles and drags resize the window frame via the platform's
 * windowControls. happy-dom dispatches synthetic MouseEvents with screen coordinates, and the
 * platform is a plain spy object on globalThis.__jxPlatform.
 */
import { flush } from "./harness";
import { afterAll, describe, expect, test } from "bun:test";
import { mountResizeEdges } from "../src/resize-edges";

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const g = globalThis as unknown as {
  __jxPlatform?: {
    windowControls?: {
      getFrame: () => Promise<Frame>;
      setFrame: (x: number, y: number, w: number, h: number) => void;
    };
  };
};

const setFrameCalls: number[][] = [];
let frame: Frame = { height: 600, width: 800, x: 10, y: 20 };

function installWindowControls() {
  g.__jxPlatform = {
    windowControls: {
      getFrame: async () => ({ ...frame }),
      setFrame: (x: number, y: number, w: number, h: number) => {
        setFrameCalls.push([x, y, w, h]);
      },
    },
  };
}

function edgeEl(edge: string): HTMLElement {
  const el = document.querySelector(`#resize-edges .resize-edge.${edge}`);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

/** Press on an edge handle, move the mouse, and return the last setFrame call. */
async function drag(edge: string, dx: number, dy: number): Promise<number[] | undefined> {
  setFrameCalls.length = 0;
  const el = edgeEl(edge);
  const down = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    screenX: 100,
    screenY: 100,
  });
  el.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  // StartResize awaits getFrame before installing the move handlers
  await flush();
  document.dispatchEvent(new MouseEvent("mousemove", { screenX: 100 + dx, screenY: 100 + dy }));
  const last = setFrameCalls.at(-1);
  document.dispatchEvent(new MouseEvent("mouseup"));
  return last;
}

afterAll(() => {
  delete g.__jxPlatform;
  document.querySelector("#resize-edges")?.remove();
});

describe("mountResizeEdges — guards", () => {
  test("does nothing without a platform windowControls", () => {
    delete g.__jxPlatform;
    mountResizeEdges();
    expect(document.querySelector("#resize-edges")).toBeNull();
  });

  test("does nothing when windowControls lacks getFrame", () => {
    g.__jxPlatform = { windowControls: {} as never };
    mountResizeEdges();
    expect(document.querySelector("#resize-edges")).toBeNull();
  });

  test("mounts a container with all eight edge handles", () => {
    installWindowControls();
    mountResizeEdges();
    const container = document.querySelector("#resize-edges");
    expect(container).not.toBeNull();
    expect(container?.children).toHaveLength(8);
    const classes = [...(container?.children ?? [])].map((c) => c.className);
    expect(classes).toEqual([
      "resize-edge top",
      "resize-edge bottom",
      "resize-edge left",
      "resize-edge right",
      "resize-edge top-left",
      "resize-edge top-right",
      "resize-edge bottom-left",
      "resize-edge bottom-right",
    ]);
  });

  test("mounting twice is a no-op", () => {
    mountResizeEdges();
    expect(document.querySelectorAll("#resize-edges")).toHaveLength(1);
  });
});

describe("resize drags", () => {
  test("right edge grows width", async () => {
    expect(await drag("right", 50, 0)).toEqual([10, 20, 850, 600]);
  });

  test("right edge clamps to min width", async () => {
    expect(await drag("right", -700, 0)).toEqual([10, 20, 400, 600]);
  });

  test("left edge moves x and shrinks width", async () => {
    expect(await drag("left", 30, 0)).toEqual([40, 20, 770, 600]);
  });

  test("left edge clamps to min width and shifts x by the clamped delta", async () => {
    // NewW = max(400, 800 - 500) = 400; x += 800 - 400
    expect(await drag("left", 500, 0)).toEqual([410, 20, 400, 600]);
  });

  test("bottom edge grows height", async () => {
    expect(await drag("bottom", 0, 40)).toEqual([10, 20, 800, 640]);
  });

  test("top edge moves y and grows height when dragged up", async () => {
    expect(await drag("top", 0, -25)).toEqual([10, -5, 800, 625]);
  });

  test("top edge clamps to min height", async () => {
    // NewH = max(300, 600 - 400) = 300; y += 600 - 300
    expect(await drag("top", 0, 400)).toEqual([10, 320, 800, 300]);
  });

  test("bottom-right corner resizes both axes", async () => {
    expect(await drag("bottom-right", 15, 25)).toEqual([10, 20, 815, 625]);
  });

  test("top-left corner resizes both axes and moves the origin", async () => {
    expect(await drag("top-left", -10, -10)).toEqual([0, 10, 810, 610]);
  });

  test("mouseup detaches the move handler", async () => {
    await drag("right", 10, 0);
    setFrameCalls.length = 0;
    document.dispatchEvent(new MouseEvent("mousemove", { screenX: 300, screenY: 300 }));
    expect(setFrameCalls).toHaveLength(0);
  });

  test("each mousemove resizes relative to the frame captured at mousedown", async () => {
    setFrameCalls.length = 0;
    const el = edgeEl("right");
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, screenX: 0, screenY: 0 }),
    );
    await flush();
    document.dispatchEvent(new MouseEvent("mousemove", { screenX: 10, screenY: 0 }));
    document.dispatchEvent(new MouseEvent("mousemove", { screenX: 20, screenY: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(setFrameCalls).toEqual([
      [10, 20, 810, 600],
      [10, 20, 820, 600],
    ]);
  });

  test("frame changes between drags are picked up via getFrame", async () => {
    frame = { height: 500, width: 900, x: 0, y: 0 };
    expect(await drag("bottom", 0, 10)).toEqual([0, 0, 900, 510]);
  });
});
