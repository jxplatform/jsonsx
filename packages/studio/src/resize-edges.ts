/// <reference lib="dom" />
const g = globalThis as unknown as {
  __jxPlatform?: {
    windowControls?: {
      getFrame: () => Promise<{ x: number; y: number; width: number; height: number }>;
      setFrame: (x: number, y: number, w: number, h: number) => void;
    };
  };
};

const EDGES = [
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

let mounted = false;

export function mountResizeEdges() {
  const wc = g.__jxPlatform?.windowControls;
  if (!wc || !wc.getFrame || mounted) return;
  mounted = true;

  const container = document.createElement("div");
  container.id = "resize-edges";

  for (const edge of EDGES) {
    const el = document.createElement("div");
    el.className = `resize-edge ${edge}`;
    el.addEventListener("mousedown", (e) => startResize(e, edge, wc));
    container.appendChild(el);
  }

  document.body.appendChild(container);
}

/**
 * @param {MouseEvent} e
 * @param {string} edge
 * @param {{
 *   getFrame: () => Promise<{ x: number; y: number; width: number; height: number }>;
 *   setFrame: (x: number, y: number, w: number, h: number) => void;
 * }} wc
 */
async function startResize(
  e: MouseEvent,
  edge: string,
  wc: {
    getFrame: () => Promise<{ x: number; y: number; width: number; height: number }>;
    setFrame: (x: number, y: number, w: number, h: number) => void;
  },
) {
  e.preventDefault();
  e.stopPropagation();

  const startX = e.screenX;
  const startY = e.screenY;
  const frame = await wc.getFrame();
  const startFrame = { ...frame };

  /** @param {MouseEvent} me */
  function onMove(me: MouseEvent) {
    const dx = me.screenX - startX;
    const dy = me.screenY - startY;

    let { x, y, width, height } = startFrame;

    if (edge.includes("right")) {
      width = Math.max(MIN_WIDTH, width + dx);
    }
    if (edge.includes("left")) {
      const newW = Math.max(MIN_WIDTH, width - dx);
      x = x + (width - newW);
      width = newW;
    }
    if (edge.includes("bottom")) {
      height = Math.max(MIN_HEIGHT, height + dy);
    }
    if (edge.includes("top")) {
      const newH = Math.max(MIN_HEIGHT, height - dy);
      y = y + (height - newH);
      height = newH;
    }

    wc.setFrame(x, y, width, height);
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
