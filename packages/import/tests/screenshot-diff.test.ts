import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { diffScreenshots } from "../src/screenshot-diff.ts";

function makePng(width: number, height: number, fill: [number, number, number, number]): Buffer {
  const img = new PNG({ width, height });
  const [r, g, b, a] = fill;
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  return PNG.sync.write(img);
}

function makeCheckerboard(width: number, height: number): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const isWhite = (x + y) % 2 === 0;
      img.data[i] = isWhite ? 255 : 0;
      img.data[i + 1] = isWhite ? 255 : 0;
      img.data[i + 2] = isWhite ? 255 : 0;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

describe("screenshot-diff", () => {
  it("identical images → 100% fidelity", () => {
    const png = makePng(10, 10, [255, 0, 0, 255]);
    const result = diffScreenshots(png, png);
    expect(result.fidelity).toBe(100);
    expect(result.mismatchedPixels).toBe(0);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });

  it("completely different images → low fidelity", () => {
    const white = makePng(10, 10, [255, 255, 255, 255]);
    const black = makePng(10, 10, [0, 0, 0, 255]);
    const result = diffScreenshots(white, black);
    expect(result.fidelity).toBeLessThan(5);
    expect(result.mismatchedPixels).toBe(100);
  });

  it("same-color images of same size → 100%", () => {
    const a = makePng(50, 50, [128, 64, 32, 255]);
    const b = makePng(50, 50, [128, 64, 32, 255]);
    const result = diffScreenshots(a, b);
    expect(result.fidelity).toBe(100);
  });

  it("different sizes → pads smaller with white", () => {
    const small = makePng(5, 5, [255, 255, 255, 255]);
    const large = makePng(10, 10, [255, 255, 255, 255]);
    const result = diffScreenshots(small, large);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(result.fidelity).toBe(100);
  });

  it("different sizes with different colors → partial match", () => {
    const small = makePng(5, 5, [0, 0, 0, 255]);
    const large = makePng(10, 10, [0, 0, 0, 255]);
    const result = diffScreenshots(small, large);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    // 5x5 matching area, but the padded area (white vs black) will mismatch
    expect(result.fidelity).toBeLessThan(100);
    expect(result.fidelity).toBeGreaterThan(0);
  });

  it("returns a valid diff PNG buffer", () => {
    const white = makePng(10, 10, [255, 255, 255, 255]);
    const black = makePng(10, 10, [0, 0, 0, 255]);
    const result = diffScreenshots(white, black);
    expect(result.diffPng).toBeInstanceOf(Buffer);
    expect(result.diffPng.length).toBeGreaterThan(0);
    // Should be parseable as PNG
    const parsed = PNG.sync.read(result.diffPng);
    expect(parsed.width).toBe(10);
    expect(parsed.height).toBe(10);
  });

  it("respects threshold option", () => {
    // Similar but not identical colors
    const a = makePng(10, 10, [128, 128, 128, 255]);
    const b = makePng(10, 10, [130, 130, 130, 255]);

    const strictResult = diffScreenshots(a, b, { threshold: 0 });
    const lenientResult = diffScreenshots(a, b, { threshold: 0.5 });

    expect(lenientResult.fidelity).toBeGreaterThanOrEqual(strictResult.fidelity);
  });

  it("checkerboard vs solid → ~50% match", () => {
    const checker = makeCheckerboard(10, 10);
    const black = makePng(10, 10, [0, 0, 0, 255]);
    const result = diffScreenshots(checker, black);
    // Roughly half the pixels match (the black squares)
    expect(result.fidelity).toBeGreaterThan(30);
    expect(result.fidelity).toBeLessThan(70);
  });

  it("totalPixels matches width * height", () => {
    const png = makePng(20, 15, [100, 100, 100, 255]);
    const result = diffScreenshots(png, png);
    expect(result.totalPixels).toBe(300);
  });
});
