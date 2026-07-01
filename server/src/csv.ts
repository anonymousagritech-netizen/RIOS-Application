/**
 * Tiny CSV helper for server-side exports (Excel-openable) and imports.
 * RFC-4180 quoting both ways. Money is emitted from integer minor units →
 * major with 2 decimals; parsing returns raw strings (validation/coercion is
 * the importer's job, e.g. /api/import/validate).
 */

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function majorFromMinor(minor: number | string | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '';
  return (Number(minor) / 100).toFixed(2);
}

/** Build a CSV string from a header row and value rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join('\n');
}

/** Raised when CSV text is structurally malformed; `line` is 1-based in the source file. */
export class CsvParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

/**
 * Parse CSV text into records of string cells (RFC-4180).
 *
 * Handles quoted fields with embedded delimiters/newlines, `""` quote escapes,
 * CRLF/LF/CR row breaks, and a leading BOM. Blank lines are skipped. Throws
 * `CsvParseError` on an unterminated quote or on text after a closing quote.
 * All cells come back as strings - no type coercion here.
 */
export function parseCsvRecords(text: string, delimiter = ','): string[][] {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new CsvParseError('delimiter must be a single character other than a quote or newline', 1);
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip UTF-8 BOM

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  // 'start': at the beginning of a field; 'unquoted'/'quoted': inside one;
  // 'closed': just after a quoted field's closing quote.
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  let line = 1;
  let quoteOpenedAt = 1;

  const endField = (): void => {
    record.push(field);
    field = '';
    state = 'start';
  };
  const endRecord = (): void => {
    // A newline while still at 'start' with nothing collected is a blank line - skip it.
    if (state === 'start' && field === '' && record.length === 0) return;
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (state === 'quoted') {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // "" escape
          i += 1;
        } else {
          state = 'closed';
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch; // delimiters and newlines are literal inside quotes
      }
      continue;
    }
    const isNewline = ch === '\n' || ch === '\r';
    if (isNewline) {
      if (ch === '\r' && src[i + 1] === '\n') i += 1; // CRLF
      endRecord();
      line += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (state === 'start') {
      if (ch === '"') {
        state = 'quoted';
        quoteOpenedAt = line;
      } else {
        field += ch;
        state = 'unquoted';
      }
    } else if (state === 'unquoted') {
      if (ch === '"') throw new CsvParseError(`unexpected quote inside unquoted field at line ${line}`, line);
      field += ch;
    } else {
      // state === 'closed': only a delimiter or newline may follow a closing quote
      throw new CsvParseError(`unexpected character ${JSON.stringify(ch)} after closing quote at line ${line}`, line);
    }
  }

  if (state === 'quoted') {
    throw new CsvParseError(`unterminated quoted field (quote opened at line ${quoteOpenedAt})`, quoteOpenedAt);
  }
  endRecord(); // final record when the text does not end with a newline
  return records;
}
