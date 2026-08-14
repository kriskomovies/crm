/**
 * Who gets forwarded to the follow queue.
 *
 * The origin boxes are built from this client's own ledger. Neither side ever
 * hardcoded them, but the server did, and a fixed list of 16 capitalised names
 * had drifted from what the model actually returns: on the live client it could
 * not offer `welsh` (19 people), `hebrew`, `japanese` or `romanian` at all, and
 * the `unknown` box it did offer matched nobody, because a person with no
 * nationality read is stored as null. Second-largest bucket, 112 people, no way
 * to target them.
 *
 * So the counts ride along with the values. "Is this worth ticking" is now
 * answerable here rather than on the stats tab.
 *
 * The box that targets that bucket is `no nationality read`, and it is a NEW
 * option, not the old `unknown` one repaired -- see NO_NATIONALITY in api.ts
 * for why reusing the string would have changed what live rules forward on
 * deploy. A rule still holding the dead tick shows it as `unknown`, count 0,
 * marked `none now`: untick it, or leave it, but it forwards nobody either way.
 */
import { useEffect, useState } from 'react';

import { NO_NATIONALITY, api, type Rule, type RuleOptions } from './api';

export function Targeting() {
  const [options, setOptions] = useState<RuleOptions | null>(null);
  const [rule, setRule] = useState<Rule | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .rules()
      .then((r) => {
        setOptions(r.options);
        setRule(r.rule);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) return <div className="card error">{err}</div>;
  if (!options || !rule) return <div className="card muted">Loading…</div>;

  // The filter folds case (pipeline.service.ts, since 566f1a7 "Country filter
  // matched case-sensitively and forwarded nobody") and the option list now
  // carries whatever casing the data holds, which is lowercase. A rule saved
  // before that still holds 'English', and an exact includes() would render its
  // chip UNTICKED while it was quietly forwarding every english-reading name --
  // a targeting screen lying about what it is targeting. Fold on both sides.
  const has = (list: string[], value: string) =>
    list.some((v) => v.toLowerCase() === value.toLowerCase());

  const toggle = (list: string[], value: string) =>
    has(list, value)
      ? list.filter((v) => v.toLowerCase() !== value.toLowerCase())
      : [...list, value];

  async function save() {
    if (!rule) return;
    setBusy(true);
    setSaved(null);
    try {
      const res = await api.saveRules(rule);
      setRule(res.rule);
      setSaved(res.note ?? 'Saved. Applies to the next sheet extracted.');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <div className="targeting">
      <div className="card">
        <h2>Who to follow</h2>
        <p className="muted small">
          Applies as each sheet is extracted. Anyone who does not match is still
          stored in the ledger — changing this affects new sheets, not old ones.
        </p>

        <h3>Presents as</h3>
        <div className="chips">
          {options.presentsAs.map((p) => (
            <label key={p} className={rule.presentsAs.includes(p) ? 'chip on' : 'chip'}>
              <input
                type="checkbox"
                checked={rule.presentsAs.includes(p)}
                onChange={() => setRule({ ...rule, presentsAs: toggle(rule.presentsAs, p) })}
              />
              {p}
            </label>
          ))}
        </div>
        <p className="muted small">
          Judged from the avatar and the name independently; they only agree on a
          match. Measured leak on the men-only bucket is about 2%.
        </p>

        <h3>Name origin</h3>
        <div className="chips grid">
          {options.origins.map((o) => (
            <label
              key={o.value}
              className={has(rule.countries, o.value) ? 'chip on' : 'chip'}
              title={
                o.value === NO_NATIONALITY
                  ? 'The model read a name but could not place it. Minimum ' +
                    'confidence does not apply to these — there is no reading ' +
                    'to grade.'
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={has(rule.countries, o.value)}
                onChange={() => setRule({ ...rule, countries: toggle(rule.countries, o.value) })}
              />
              <span className="label">
                {o.value === NO_NATIONALITY ? 'no origin read' : o.value}
              </span>
              {/* A count the server did not send is left blank rather than
                  printed as 0, which would read as "gone" on every box. */}
              {o.count !== null && (
                <span className={o.count === 0 ? 'n gone' : 'n'}>
                  {o.count === 0 ? 'none now' : o.count}
                </span>
              )}
            </label>
          ))}
        </div>
        {/* The question this answers gets asked every time somebody looks for
            "american" and does not find it. It is not a gap in the data: the
            extraction prompt instructs the model NOT to split generic
            English-language names into American, British, Canadian or
            Australian, because a name like "John Smith" carries nothing that
            separates them and guessing there produces noise. Geography is the
            proxy's job, not this field's. */}
        <p className="muted small">
          From your own sheets, commonest first. Nothing ticked forwards{' '}
          <b>every</b> origin. <b>english</b> covers every anglophone name — American,
          British, Canadian and Australian are deliberately not split, because a name
          alone cannot tell them apart.
        </p>

        <h3>Skin tone</h3>
        <div className="chips grid">
          {options.skinTones.map((t) => (
            <label key={t} className={rule.skinTones.includes(t) ? 'chip on' : 'chip'}>
              <input
                type="checkbox"
                checked={rule.skinTones.includes(t)}
                onChange={() => setRule({ ...rule, skinTones: toggle(rule.skinTones, t) })}
              />
              <span className="label">{t}</span>
            </label>
          ))}
        </div>
        <p className="muted small">
          The face colour of the drawn avatar, not a claim about a person — a
          Bitmoji tone is a setting the account chose. Selecting nothing forwards
          <b> every</b> tone. Naming tones also drops anyone whose avatar had no
          readable face (<i>placeholder</i>, <i>stylised</i>, <i>unreadable</i>).
        </p>

        <h3>Minimum confidence</h3>
        <div className="chips">
          {options.confidences.map((c) => (
            <label key={c} className={rule.minConfidence === c ? 'chip on' : 'chip'}>
              <input
                type="radio"
                name="conf"
                checked={rule.minConfidence === c}
                onChange={() => setRule({ ...rule, minConfidence: c })}
              />
              {c}
            </label>
          ))}
        </div>
        <p className="muted small">
          Keep this at <b>low</b> unless you have a reason. A first name is weak
          evidence and the model says so honestly: 80 of 99 entries on the
          reference sheet come back low, and a <i>medium</i> bar passed just one
          English-reading man in sixty-five.
        </p>
        {/* Said on the page, not just in the code. The bar grades the origin
            reading, so it cannot grade a person who has none — those forward on
            the origin boxes alone, at every setting. Without this line the
            control silently means something different for one of the boxes
            above, which is the same class of defect as the option list that
            could not name what the model returned. */}
        <p className="muted small">
          It grades the origin reading itself, so it does not apply to{' '}
          <b>no nationality read</b> — there is nothing there to grade. Those
          people forward whenever the boxes above match them, whichever bar is
          set here.
        </p>

        <div className="row">
          <button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="muted small">{saved}</span>}
        </div>
      </div>
    </div>
  );
}
