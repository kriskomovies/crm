import { useEffect, useState, type ReactNode } from 'react';

import { api, isAbort, type Personality, type Stats as StatsData, type StatsDay } from './api';
import { count, money, rate } from './ui';

const RANGES = [7, 30, 90];

const METRICS = [
  { key: 'targets', label: 'targets' },
  { key: 'followed', label: 'follows' },
  { key: 'sheets', label: 'sheets' },
  { key: 'usd', label: 'spend' },
] as const;

type Metric = (typeof METRICS)[number]['key'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * byDay rows are calendar days the server has already bucketed, not instants.
 * new Date('2026-07-30') reads them back as UTC midnight, which prints as the
 * 29th anywhere west of Greenwich, so the label is cut from the string instead.
 */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}` : iso;
}

/**
 * Everything the run produced, filtered by personality (the "per model" filter)
 * and by a date range.
 *
 * The personality list is handed down rather than fetched again: App already
 * polls it, and a second copy here would drift from the one in the header.
 */
export function Stats({ personalities }: { personalities: Personality[] }) {
  const [personalityId, setPersonalityId] = useState('');
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<Metric>('targets');
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // A personality deleted while it was selected leaves the select holding a
  // value it has no option for, which renders as a blank box. Fall back to all.
  const selected = personalities.some((p) => p.id === personalityId) ? personalityId : '';


  useEffect(() => {
    const ac = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    setLoading(true);
    api
      .stats(
        { personalityId: selected || undefined, from: from.toISOString(), to: to.toISOString() },
        ac.signal,
      )
      .then((s) => {
        setData(s);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!isAbort(e)) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        // Aborted means a newer request is already in flight and owns the flag.
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [selected, days]);

  const t = data?.totals;

  return (
    <>
      <div className="toolbar">
        <select value={selected} onChange={(e) => setPersonalityId(e.target.value)}>
          <option value="">All personalities</option>
          {personalities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="seg">
          {RANGES.map((d) => (
            <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
        {data && (
          <span className="muted small">
            {shortDate(data.range.from)} – {shortDate(data.range.to)}
          </span>
        )}
        {loading && <span className="muted small">loading…</span>}
      </div>

      {err && <p className="error banner">Stats unavailable — {err}</p>}

      {t && data && (
        <>
          <div className="tiles">
            <Tile label="sheets" value={count(t.sheets)} />
            <Tile label="profiles read" value={count(t.profilesRead)} />
            <Tile label="targets attached" value={count(t.targets)} />
            <Tile
              label="spend"
              value={money(t.usd, 2)}
              sub={`${count(t.promptTokens + t.completionTokens)} tokens`}
            />
            <Tile
              label="follows"
              value={count(t.followed)}
              sub={`${count(t.failed)} failed · ${count(t.skipped)} skipped`}
            />
          </div>

          <p className="muted small pipeline">
            queued {count(t.queued)} · handed out {count(t.handedOut)}
          </p>

          <section className="panel">
            <header className="panel-head">
              <h3>By day</h3>
              <div className="seg">
                {METRICS.map((m) => (
                  <button
                    key={m.key}
                    className={metric === m.key ? 'on' : ''}
                    onClick={() => setMetric(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </header>
            <div className="inset">
              <DayChart days={data.byDay} metric={metric} />
            </div>
          </section>

          <Table
            title="By country"
            empty={data.byCountry.length === 0}
            head={
              <tr>
                <th>origin</th>
                <th className="num">people</th>
                <th className="num">forwarded</th>
                <th className="num">share</th>
              </tr>
            }
          >
            {data.byCountry.map((c, i) => (
              <tr key={c.nationality ?? `unknown-${i}`}>
                <td data-label="origin">
                  {c.nationality ?? <span className="muted">unknown</span>}
                </td>
                <td data-label="people" className="num">
                  {count(c.count)}
                </td>
                <td data-label="forwarded" className="num">
                  {count(c.forwarded)}
                </td>
                <td data-label="share" className="num">
                  {rate(c.forwarded, c.count)}
                </td>
              </tr>
            ))}
          </Table>

        </>
      )}

      {!data && !err && !loading && <p className="muted">No stats yet.</p>}
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

/**
 * A bar per day, hand-rolled so the page keeps its two dependencies.
 *
 * Every bar sits in a full-height track, so a range where nothing happened
 * reads as "nothing happened" rather than as a broken chart.
 */
function DayChart({ days, metric }: { days: StatsDay[]; metric: Metric }) {
  if (days.length === 0) return <p className="muted small">No activity in this range.</p>;

  const values = days.map((d) => d[metric]);
  const peak = Math.max(...values);
  // Never scale against the max directly: an all-zero range would make every
  // height NaN and the bars would disappear along with the tracks.
  const scale = peak > 0 ? peak : 1;

  const H = 100;
  const step = 100 / days.length;
  const bar = step * 0.7;
  const inset = (step - bar) / 2;
  const format = (v: number) => (metric === 'usd' ? money(v, 4) : count(v));

  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${metric} per day, peak ${format(peak)}`}
      >
        {days.map((d, i) => {
          const v = values[i];
          // Anything above zero keeps at least a sliver of height, otherwise a
          // day with one follow in a month of hundreds rounds away to nothing.
          const h = v > 0 ? Math.max((v / scale) * H, 2) : 0;
          return (
            <g key={`${d.date}-${i}`}>
              <title>{`${shortDate(d.date)} — ${format(v)}`}</title>
              <rect className="chart-slot" x={i * step + inset} y={0} width={bar} height={H} />
              {h > 0 && (
                <rect className="chart-bar" x={i * step + inset} y={H - h} width={bar} height={h} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-axis">
        <span>{shortDate(days[0].date)}</span>
        <span>peak {format(peak)}</span>
        <span>{shortDate(days[days.length - 1].date)}</span>
      </div>
    </>
  );
}

function Table({
  title,
  empty,
  head,
  children,
}: {
  title: string;
  empty: boolean;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>{title}</h3>
      </header>
      {empty ? (
        <p className="muted small inset">Nothing in this range.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>{head}</thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
