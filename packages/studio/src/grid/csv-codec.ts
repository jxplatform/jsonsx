/**
 * Positional CSV codec for the grid editor.
 *
 * RFC 4180 parse/serialize that keeps what the parser extension's object-row loader discards:
 * column order, duplicate/empty headers, untrimmed whitespace, the file's dominant EOL, and whether
 * it ended with a newline. Values stay raw strings — typing lives in schema-columns. Serialization
 * is canonical (quotes only where required), so an edited file is re-emitted minimally quoted;
 * untouched files are never rewritten.
 */

export interface CsvDocument {
  headers: string[];
  rows: string[][];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
}

/** Split CSV text into records of raw fields, honoring quotes across commas and newlines. */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    fields.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // A completely empty line is structure, not data — skip it (common trailing-blank case).
    if (fields.length === 1 && fields[0] === "") {
      fields = [];
      return;
    }
    records.push(fields);
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === '"') {
      // Quote inside an unquoted field — keep it literal (lenient, matches common parsers).
      field += ch;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        i += 1;
      }
      endRecord();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== "" || fields.length > 0) {
    endRecord();
  }
  return records;
}

/**
 * Parse CSV text into headers + positional rows. Rows are padded to the header width; when a data
 * row is wider than the header row, headers are padded with "" so no column is lost.
 */
export function parseCsv(text: string): CsvDocument {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const eol: CsvDocument["eol"] = crlf > bareLf ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");

  const records = splitRecords(text);
  const headers = records[0] ?? [];
  const rows = records.slice(1);
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  while (headers.length < width) {
    headers.push("");
  }
  for (const row of rows) {
    while (row.length < width) {
      row.push("");
    }
  }
  return { eol, headers, rows, trailingNewline };
}

/** Quote a field iff it contains a delimiter, quote, or newline; double embedded quotes. */
function encodeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** Serialize back to CSV text, preserving the document's EOL flavor and trailing-newline flag. */
export function serializeCsv(doc: CsvDocument): string {
  const lines = [doc.headers, ...doc.rows].map((fields) =>
    fields.map((field) => encodeField(field)).join(","),
  );
  return lines.join(doc.eol) + (doc.trailingNewline ? doc.eol : "");
}
