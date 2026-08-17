/**
 * When the operator's day began. Every daily cap is counted from this instant.
 *
 * WHY THIS IS ONE FUNCTION AND NOT THREE
 *
 * It was three: a private copy in TargetsService (which spends the cap),
 * PersonalitiesService (which reports it per account) and StatsService (which
 * draws the bar). Identical bodies, identical comments, and three chances for
 * the gauge to disagree with the budget it is drawing -- an operator reading
 * "0/240" off a page that counts one day while the handout counts another has
 * no way to tell which is lying.
 *
 * WHY IT FOLLOWS THE PROCESS TIMEZONE
 *
 * A cap is a promise about a DAY, and a day is a human unit: the number an
 * operator watches has to reset when their date changes, not at some hour that
 * happens to be midnight elsewhere. setHours reads the process zone, so `TZ` on
 * the container is what a deployment sets, and the platform owns the awkward
 * parts -- DST, half-hour offsets, the 23- and 25-hour days.
 *
 * This has one deployment consequence worth stating plainly: with no TZ set,
 * Node is UTC, "local midnight" IS UTC midnight, and every comment in this
 * codebase promising the operator's day is quietly false. Measured on
 * 2026-08-17: an account that had been handed 156 people between 02:04 and
 * 02:58 that morning showed 0/240, because the UTC day had rolled over at 03:00
 * local and taken the evening's work with it. Nothing was wrong with the
 * counting. The container had no timezone.
 *
 * `now` is injectable for the tests and for nothing else. Production has one
 * clock and does not pass it.
 */
export function startOfToday(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The same instant, written so $queryRaw cannot reinterpret it.
 *
 * Binding a JS Date sends `timestamptz`, which Postgres converts against the
 * session TimeZone before comparing it to the `timestamp` columns this schema
 * holds UTC in -- silently, and three hours out on the box this was measured on.
 * A naive UTC literal has nothing left to convert.
 */
export function utcLiteral(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
