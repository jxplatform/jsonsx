import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { parseCsv, serializeCsv } from "../src/grid/csv-codec";

describe("parseCsv", () => {
  test("parses headers and positional rows", () => {
    const doc = parseCsv("name,price\nWidget,9.50\nGadget,12\n");
    expect(doc.headers).toEqual(["name", "price"]);
    expect(doc.rows).toEqual([
      ["Widget", "9.50"],
      ["Gadget", "12"],
    ]);
    expect(doc.eol).toBe("\n");
    expect(doc.trailingNewline).toBeTrue();
  });

  test("handles quoted fields with commas, quotes, and newlines", () => {
    const doc = parseCsv('title,body\n"Hello, world","line one\nline two"\n"He said ""hi""",x\n');
    expect(doc.rows[0]).toEqual(["Hello, world", "line one\nline two"]);
    expect(doc.rows[1]).toEqual(['He said "hi"', "x"]);
  });

  test("preserves untrimmed whitespace and duplicate/empty headers", () => {
    const doc = parseCsv("a, a ,\n 1 ,2,3\n");
    expect(doc.headers).toEqual(["a", " a ", ""]);
    expect(doc.rows[0]).toEqual([" 1 ", "2", "3"]);
  });

  test("detects CRLF EOL and missing trailing newline", () => {
    const doc = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(doc.eol).toBe("\r\n");
    expect(doc.trailingNewline).toBeFalse();
    expect(doc.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("quoted CRLF stays inside the field", () => {
    const doc = parseCsv('a,b\r\n"x\r\ny",2\r\n');
    expect(doc.rows[0]).toEqual(["x\r\ny", "2"]);
  });

  test("pads short rows to header width and widens headers for long rows", () => {
    const doc = parseCsv("a,b\n1\n1,2,3\n");
    expect(doc.headers).toEqual(["a", "b", ""]);
    expect(doc.rows).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
  });

  test("skips fully empty lines but keeps rows of empty fields", () => {
    const doc = parseCsv("a,b\n\n1,2\n\n\n");
    expect(doc.rows).toEqual([["1", "2"]]);
    const commas = parseCsv("a,b\n,\n");
    expect(commas.rows).toEqual([["", ""]]);
  });

  test("stray quote inside an unquoted field stays literal", () => {
    const doc = parseCsv('a,b\nit"s,2\n');
    expect(doc.rows[0]).toEqual(['it"s', "2"]);
  });

  test("empty input yields an empty document", () => {
    const doc = parseCsv("");
    expect(doc.headers).toEqual([]);
    expect(doc.rows).toEqual([]);
    expect(doc.trailingNewline).toBeFalse();
  });
});

describe("serializeCsv", () => {
  test("quotes only where required and doubles embedded quotes", () => {
    const text = serializeCsv({
      eol: "\n",
      headers: ["title", "body"],
      rows: [
        ['He said "hi"', "plain"],
        ["with,comma", "line\nbreak"],
      ],
      trailingNewline: true,
    });
    expect(text).toBe('title,body\n"He said ""hi""",plain\n"with,comma","line\nbreak"\n');
  });

  test("preserves EOL flavor and trailing-newline flag", () => {
    const crlf = serializeCsv({
      eol: "\r\n",
      headers: ["a"],
      rows: [["1"]],
      trailingNewline: false,
    });
    expect(crlf).toBe("a\r\n1");
  });

  test("round-trips a parsed document", () => {
    const original = 'name,tags,notes\nWidget,"red, blue","multi\nline"\nGadget,,\n';
    const doc = parseCsv(original);
    expect(serializeCsv(doc)).toBe(original);
  });

  test("round-trips CRLF documents", () => {
    const original = "a,b\r\n1,2\r\n";
    expect(serializeCsv(parseCsv(original))).toBe(original);
  });
});
