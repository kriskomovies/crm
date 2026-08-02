/**
 * Who gets forwarded to the follow queue.
 *
 * The vocabulary comes from the server rather than being hardcoded here, so the
 * boxes can never offer an origin the extractor does not actually return --
 * which is precisely how the old rule managed to match nothing at all.
 *
 * "English" is one option, not four. Three runs over the real 99-profile sheet
 * put 64-66 names in that bucket and named a specific anglophone country for at
 * most seven; British came up once and Australian never. Offering US/UK/CA/AU
 * separately would be four checkboxes that return nothing.
 */
import { useEffect, useState } from 'react';

import { api, type Rule, type RuleOptions } from './api';

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

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

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
        <div className="chips">
          {options.origins.map((o) => (
            <label key={o} className={rule.countries.includes(o) ? 'chip on' : 'chip'}>
              <input
                type="checkbox"
                checked={rule.countries.includes(o)}
                onChange={() => setRule({ ...rule, countries: toggle(rule.countries, o) })}
              />
              {o}
            </label>
          ))}
        </div>
        <p className="muted small">
          <b>English</b> means the name reads as generically English — it does not
          distinguish American, British, Canadian or Australian, because a name
          does not. Selecting nothing here forwards <b>every</b> origin.
        </p>

        <h3>Skin tone</h3>
        <div className="chips">
          {options.skinTones.map((t) => (
            <label key={t} className={rule.skinTones.includes(t) ? 'chip on' : 'chip'}>
              <input
                type="checkbox"
                checked={rule.skinTones.includes(t)}
                onChange={() => setRule({ ...rule, skinTones: toggle(rule.skinTones, t) })}
              />
              {t}
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
