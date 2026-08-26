/**
 * Src/services/import-run.ts — the live state of an import, keyed by the tool call that started it.
 * The record is what stops a successful run destroying its own account of what it did.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_LOG_LINES,
  abortImportRun,
  activeImportRun,
  beginImportRun,
  finishImportRun,
  importRun,
  recordImportProgress,
  resetImportRuns,
} from "../src/services/import-run";

const INIT = { directory: "/home/dev/Sites/example", url: "https://example.com/" };

afterEach(() => {
  resetImportRuns();
});

describe("import-run", () => {
  test("opens a running record and hands back the request's signal", () => {
    const signal = beginImportRun("call_1", INIT);
    expect(signal.aborted).toBe(false);
    expect(importRun("call_1")).toMatchObject({
      directory: "/home/dev/Sites/example",
      id: "call_1",
      status: "running",
      url: "https://example.com/",
    });
    expect(activeImportRun()?.id).toBe("call_1");
  });

  test("progress moves the head line and appends to the log", () => {
    beginImportRun("call_1", INIT);
    recordImportProgress("call_1", {
      current: 3,
      message: "Crawled 3 pages",
      phase: "crawl",
      total: 20,
    });

    expect(importRun("call_1")).toMatchObject({
      current: 3,
      message: "Crawled 3 pages",
      phase: "crawl",
      total: 20,
    });
    expect(importRun("call_1")!.log).toHaveLength(1);
  });

  test("a line with no counts clears the determinate reading", () => {
    // A determinate bar left over from the previous phase would report the wrong progress.
    beginImportRun("call_1", INIT);
    recordImportProgress("call_1", { current: 3, message: "Crawled", phase: "crawl", total: 20 });
    recordImportProgress("call_1", { message: "Writing project...", phase: "emit" });

    expect(importRun("call_1")).toMatchObject({ current: null, total: null });
  });

  test("warnings are harvested out of the prefixed lines", () => {
    /* `ImportSiteResult.warnings` does not cross the HTTP boundary — the `⚠` prefix on the progress
       line is the only place they survive, and the summary needs them to be honest. */
    beginImportRun("call_1", INIT);
    recordImportProgress("call_1", { message: "⚠ 3 assets failed to download", phase: "assets" });
    recordImportProgress("call_1", { message: "Wrote 12 files", phase: "emit" });

    expect(importRun("call_1")!.warnings).toEqual(["3 assets failed to download"]);
  });

  test("the log keeps its tail rather than growing without bound", () => {
    beginImportRun("call_1", INIT);
    for (let i = 0; i < MAX_LOG_LINES + 25; i++) {
      recordImportProgress("call_1", { message: `line ${i}`, phase: "crawl" });
    }
    const { log } = importRun("call_1")!;
    expect(log).toHaveLength(MAX_LOG_LINES);
    expect(log.at(-1)!.message).toBe(`line ${MAX_LOG_LINES + 24}`);
    expect(log[0]!.message).toBe("line 25");
  });

  test("progress for an unknown run is ignored rather than throwing", () => {
    expect(() => recordImportProgress("gone", { message: "x", phase: "crawl" })).not.toThrow();
  });

  test("finishing settles the record and empties the active slot", () => {
    beginImportRun("call_1", INIT);
    finishImportRun("call_1", { status: "done" });
    expect(importRun("call_1")!.status).toBe("done");
    expect(activeImportRun()).toBeNull();
  });

  test("a failure keeps its reason on the record", () => {
    beginImportRun("call_1", INIT);
    finishImportRun("call_1", { error: "Directory is not empty", status: "failed" });
    expect(importRun("call_1")).toMatchObject({
      error: "Directory is not empty",
      status: "failed",
    });
  });

  test("finishing an unknown run does not throw", () => {
    expect(() => finishImportRun("gone", { status: "done" })).not.toThrow();
  });

  test("a finished run stays readable under its own chip after the next one starts", () => {
    // Two attempts is the realistic case, and the first one's failure is what explains the second.
    beginImportRun("call_1", INIT);
    finishImportRun("call_1", { error: "boom", status: "failed" });
    beginImportRun("call_2", INIT);

    expect(importRun("call_1")?.status).toBe("failed");
    expect(activeImportRun()?.id).toBe("call_2");
  });

  test("only the five most recent runs are kept", () => {
    for (let i = 0; i < 7; i++) {
      beginImportRun(`call_${i}`, INIT);
      finishImportRun(`call_${i}`, { status: "done" });
    }
    expect(importRun("call_0")).toBeNull();
    expect(importRun("call_1")).toBeNull();
    expect(importRun("call_2")).not.toBeNull();
    expect(importRun("call_6")).not.toBeNull();
  });

  test("starting a second run aborts the first", () => {
    const first = beginImportRun("call_1", INIT);
    beginImportRun("call_2", INIT);
    expect(first.aborted).toBe(true);
  });

  test("abortImportRun aborts the in-flight request", () => {
    // `assistant.stop` cannot reach the tool, so it reaches the request through this store.
    const signal = beginImportRun("call_1", INIT);
    abortImportRun();
    expect(signal.aborted).toBe(true);
    expect(() => abortImportRun()).not.toThrow();
  });

  test("reset aborts and drops every record", () => {
    const signal = beginImportRun("call_1", INIT);
    resetImportRuns();
    expect(signal.aborted).toBe(true);
    expect(importRun("call_1")).toBeNull();
    expect(activeImportRun()).toBeNull();
  });
});
