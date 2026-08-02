import { useEffect, useState, type ReactNode } from 'react';

import { api, isAbort, type Personality, type Stats as StatsData, type StatsDay } from './api';
import { CapBar, count, money, rate } from './ui';

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
  const attempted = t ? t.followed + t.failed : 0;

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
            <Tile
              label="follow success"
              value={rate(t.followed, attempted)}
              sub={`${count(attempted)} attempted`}
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

          <section className="panel">
            <header className="panel-head">
              <div>
                <h3>Where handles came from</h3>
                <p className="muted small">
                  Read off a contact sheet by the vision model, or typed in.
                </p>
              </div>
            </header>
            <SourceSplit bySource={data.bySource} />
          </section>

          <Table
            title="By personality"
            empty={data.byPersonality.length === 0}
            head={
              <tr>
                <th>personality</th>
                <th className="num">sheets</th>
                <th className="num">targets</th>
                <th className="num">queued</th>
                <th className="num">followed</th>
                <th className="num">spend</th>
              </tr>
            }
          >
            {data.byPersonality.map((p) => (
              <tr key={p.id}>
                <td data-label="personality">
                  {p.name || <span className="muted">—</span>}
                </td>
                <td data-label="sheets" className="num">
                  {count(p.sheets)}
                </td>
                <td data-label="targets" className="num">
                  {count(p.targets)}
                </td>
                <td data-label="queued" className="num">
                  {count(p.queued)}
                </td>
                <td data-label="followed" className="num">
                  {count(p.followed)}
                </td>
                <td data-label="spend" className="num">
                  {money(p.usd, 2)}
                </td>
              </tr>
            ))}
          </Table>

          <Table
            title="By account"
            empty={data.byAccount.length === 0}
            head={
              <tr>
                <th>account</th>
                <th>personality</th>
                <th className="cap-col">daily cap used</th>
                <th className="num">followed</th>
                <th className="num">failed</th>
                <th className="num">success</th>
              </tr>
            }
          >
            {data.byAccount.map((a) => (
              <tr key={a.id}>
                <td data-label="account">
                  <code>{a.label}</code>
                </td>
                <td data-label="personality" className="muted">
                  {a.personality || '—'}
                </td>
                <td data-label="cap" className="cap-col">
                  <CapBar used={a.handedToday} cap={a.dailyCap} />
                </td>
                <td data-label="followed" className="num">
                  {count(a.followed)}
                </td>
                <td data-label="failed" className="num">
                  {count(a.failed)}
                </td>
                {/* Derived from the two columns beside it rather than read from
                    successRate: the contract does not pin that field to a
                    fraction or a percentage, and 0.6 vs 60 is not guessable. */}
                <td data-label="success" className="num">
                  {rate(a.followed, a.followed + a.failed)}
                </td>
              </tr>
            ))}
          </Table>

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

          <Table
            title="By model"
            empty={data.byModel.length === 0}
            head={
              <tr>
                <th>model</th>
                <th className="num">sheets</th>
                <th className="num">spend</th>
                <th className="num">avg seconds</th>
                <th className="num">avg profiles</th>
              </tr>
            }
          >
            {data.byModel.map((m, i) => (
              <tr key={m.model ?? `unknown-${i}`}>
                <td data-label="model">
                  {m.model ? <code>{m.model}</code> : <span className="muted">unknown</span>}
                </td>
                <td data-label="sheets" className="num">
                  {count(m.sheets)}
                </td>
                <td data-label="spend" className="num">
                  {money(m.usd, 4)}
                </td>
                <td data-label="avg seconds" className="num">
                  {m.avgSeconds.toFixed(1)}
                </td>
                <td data-label="avg profiles" className="num">
                  {m.avgProfiles.toFixed(1)}
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

function SourceSplit({ bySource }: { bySource: { extraction: number; manual: number } }) {
  const total = bySource.extraction + bySource.manual;
  const share = total > 0 ? (bySource.extraction / total) * 100 : 0;
  return (
    <div className="inset">
      <div className="split">
        <div className="split-a" style={{ width: `${share}%` }} />
        <div className="split-b" style={{ width: `${total > 0 ? 100 - share : 0}%` }} />
      </div>
      <div className="split-legend">
        <span>
          <i className="key key-a" /> extraction <strong>{count(bySource.extraction)}</strong>{' '}
          <span className="muted">{rate(bySource.extraction, total)}</span>
        </span>
        <span>
          <i className="key key-b" /> manual <strong>{count(bySource.manual)}</strong>{' '}
          <span className="muted">{rate(bySource.manual, total)}</span>
        </span>
      </div>
    </div>
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
