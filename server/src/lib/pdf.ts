/**
 * Zero-dependency PDF writer (simple tabular text PDF).
 *
 * Emits a genuine binary application/pdf document (PDF 1.4) - not an HTML view -
 * by hand-assembling the object table, page tree, Helvetica font and content
 * streams with a correct xref table and trailer. Layout is intentionally simple:
 * a title, a header line, and one text line per data row using fixed-width
 * columns, paginating when a page fills. Good enough for a legible tabular
 * report export without pulling in a heavy PDF/HTML-to-PDF library.
 */

const PAGE_WIDTH = 842; // A4 landscape (points) - wider for tabular data
const PAGE_HEIGHT = 595;
const MARGIN = 40;
const FONT_SIZE = 9;
const TITLE_SIZE = 15;
const LINE_HEIGHT = 13;
const ROWS_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2 - 40) / LINE_HEIGHT);

/** Escape text for a PDF literal string. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ');
}

/** Truncate/pad a cell to a fixed character width for column alignment. */
function fit(s: string, width: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length > width) return clean.slice(0, Math.max(0, width - 1)) + '…';
  return clean.padEnd(width, ' ');
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface BuildPdfOptions {
  title: string;
  subtitle?: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

/** Build a valid binary PDF from a title + tabular data. */
export function buildPdf({ title, subtitle, headers, rows }: BuildPdfOptions): Buffer {
  // Fixed character width per column (monospace-style alignment via Courier).
  const colCount = Math.max(1, headers.length);
  const totalChars = Math.floor((PAGE_WIDTH - MARGIN * 2) / (FONT_SIZE * 0.6));
  const colWidth = Math.max(8, Math.floor(totalChars / colCount));

  const line = (cells: string[]): string => cells.map((c) => fit(c, colWidth)).join('');
  const headerLine = line(headers);
  const dataLines = rows.map((row) => line(headers.map((h) => cellText(row[h]))));

  // Break rows into pages.
  const pages: string[][] = [];
  for (let i = 0; i < dataLines.length; i += ROWS_PER_PAGE) {
    pages.push(dataLines.slice(i, i + ROWS_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  // Build content stream per page.
  const contentStreams = pages.map((pageRows, pageIdx) => {
    const parts: string[] = ['BT'];
    let y = PAGE_HEIGHT - MARGIN;
    // Title only on the first page.
    if (pageIdx === 0) {
      parts.push(`/F1 ${TITLE_SIZE} Tf ${MARGIN} ${y} Td (${pdfEscape(title)}) Tj`);
      y -= LINE_HEIGHT + 6;
      if (subtitle) {
        parts.push(`ET BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${y} Td (${pdfEscape(subtitle)}) Tj`);
        y -= LINE_HEIGHT + 4;
      }
    } else {
      parts.push(`/F1 ${FONT_SIZE} Tf ${MARGIN} ${y} Td (${pdfEscape(title)} (page ${pageIdx + 1})) Tj`);
      y -= LINE_HEIGHT + 4;
    }
    // Header row (Courier bold-ish via Courier).
    parts.push(`ET BT /F2 ${FONT_SIZE} Tf ${MARGIN} ${y} Td (${pdfEscape(headerLine)}) Tj`);
    y -= LINE_HEIGHT;
    // Data rows.
    for (const r of pageRows) {
      parts.push(`ET BT /F2 ${FONT_SIZE} Tf ${MARGIN} ${y} Td (${pdfEscape(r)}) Tj`);
      y -= LINE_HEIGHT;
    }
    parts.push('ET');
    return parts.join('\n');
  });

  // Assemble PDF objects.
  // 1 Catalog, 2 Pages, 3 Font Helvetica, 4 Font Courier, then per page: page + contents.
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  const baseObjs = 4; // catalog(1) pages(2) font-helv(3) font-courier(4)
  pages.forEach((_, i) => {
    pageObjNums.push(baseObjs + 1 + i * 2); // page object number
  });

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`;

  pages.forEach((_, i) => {
    const pageNum = baseObjs + 1 + i * 2;
    const contentNum = pageNum + 1;
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = contentStreams[i]!;
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`;
  });

  // Serialize with an xref table.
  const header = '%PDF-1.4\n%\xff\xff\xff\xff\n';
  let body = header;
  const offsets: number[] = [];
  const objectCount = objects.length - 1; // index 0 unused
  for (let n = 1; n <= objectCount; n++) {
    offsets[n] = Buffer.byteLength(body, 'latin1');
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objectCount; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(body + xref + trailer, 'latin1');
}
