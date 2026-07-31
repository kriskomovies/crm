/**
 * The one pagination shape every list endpoint returns.
 *
 * Cursor, never OFFSET. A personality that has been running a month holds tens
 * of thousands of rows and OFFSET makes the database walk and discard every row
 * before the page, so page 200 costs 200 times page 1. The cursor is a stable
 * unique column, so every page costs the same.
 */

/** Hard ceiling. A caller asking for more is clamped, not refused. */
const MAX_LIMIT = 500;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function pageSize(limit: number): number {
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

/**
 * Split a `take + 1` result into a page and the cursor for the next one.
 *
 * Reading one row past the page is how "is there another page" is answered
 * without a second COUNT over the whole table -- which is the query that gets
 * slower as the ledger grows, and the reason the count is not in the contract.
 */
export function slicePage<T extends { id: string }>(rows: T[], take: number): Page<T> {
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
