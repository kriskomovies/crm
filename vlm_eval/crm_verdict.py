"""Run the CRM's own decision over a live sheet, and say WHY each person was dropped.

    python crm_verdict.py --sheet results/live_roster_99e_3c.png
    python crm_verdict.py --capture --serial 127.0.0.1:5557
    python crm_verdict.py --sheet <png> --apply --serial 127.0.0.1:5557   # touches Snapchat

WHY THIS EXISTS. When the roster looks like it is skipping people there are two
candidates and the product can distinguish neither:

  the CRM        the rule declined them -- wrong origin, wrong presentation,
                 wrong tone, too weak a reading, a near duplicate
  the automation the CRM queued them and the emulator never added them

The server cannot answer the first. `PipelineService.filter` drops with a bare
`continue`, `rejected` is computed as `people - assigned`, and the four fields
that decide it -- presentsAs, skinTone, nationalityConf, nearDuplicateOf -- are
not in the CSV export. There is no per-person "why" anywhere in the product.

So this reproduces the decision outside it: the SAME sheet, the SAME prompt
lifted live out of sheet-task.ts, the SAME model, the SAME rule fetched live
from /api/rules, and the same predicates in the same order -- but recording the
reason instead of discarding it. What comes out is a per-handle verdict you can
diff against what the CRM actually queued.

FIDELITY, and where it is knowingly short. Every predicate is a line-for-line
port of normalize.ts and pipeline.service.ts:filter, ported rather than
reimplemented, and each one names its source. One is an approximation and says
so: `nearDuplicateOf` is computed by the server against the personality's WHOLE
stored ledger, and here only against the sheet in hand, so this harness's
near-duplicate count is a LOWER bound. Nothing else here is an estimate.

--apply is off by default and is the only part that touches Snapchat. It adds
the people the rule forwarded and dismisses the ones it declined, which is what
the agent would have done, so a divergence between this and the agent is the
automation's and not the rule's.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.request
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import apimart                                    # noqa: E402
from prod_prompt import sheet_prompt              # noqa: E402

OUT = HERE / "results"
DEFAULT_CRM = "http://88.99.165.27"
DEFAULT_MODEL = "gemini-3-flash-preview-nothinking"


# ---------------------------------------------------------------------------
# port of server/src/extraction/normalize.ts
# ---------------------------------------------------------------------------

HANDLE_RE = re.compile(r"^[a-z][a-z0-9._-]{2,14}$")


def norm_handle(raw):
    return (raw or "").strip().lower().lstrip("@")


def is_plausible_handle(handle):
    return bool(HANDLE_RE.match(handle or ""))


def clean_display_name(raw):
    s = unicodedata.normalize("NFKC", raw or "")
    return " ".join(s.split())[:200]


def to_presents(raw):
    v = re.sub(r"[\s_]+", "-", (raw or "").strip().lower())
    if v in ("man", "male"):
        return "man"
    if v in ("woman", "female"):
        return "woman"
    if v in ("not-a-person", "notaperson", "none"):
        return "not-a-person"
    if v in ("ambiguous", "unisex", "unclear"):
        return "ambiguous"
    return "unknown"


def norm_country(raw):
    v = (raw or "").strip().lower()
    if not v or v in ("n/a", "none", "unknown"):
        return None
    return v[:40]


NO_NATIONALITY = "none"


def country_matches(countries, nationality):
    """normalize.ts:154. Empty = any; no reading matches ONLY the sentinel."""
    if len(countries) == 0:
        return True
    wanted = [c.strip().lower() for c in countries]
    if not nationality:
        return NO_NATIONALITY in wanted
    return nationality.strip().lower() in wanted


SKIN_TONES = ["pale", "light", "light-tan", "medium-tan", "tan", "brown",
              "dark-brown", "placeholder", "stylised", "unreadable"]

SKIN_ALIASES = {
    "light-skin": "light", "fair": "light", "light-blond": "light",
    "pale-skin": "pale", "medium": "medium-tan", "olive": "light-tan",
    "light-olive": "light-tan", "light-golden": "light-tan", "tanned": "tan",
    "silhouette": "placeholder", "stylized": "stylised",
}


def norm_skin_tone(raw):
    v = re.sub(r"[\s_]+", "-", (raw or "").strip().lower())
    v = re.sub(r"\.+$", "", v)
    if not v:
        return None
    mapped = SKIN_ALIASES.get(v, v)
    return mapped if mapped in SKIN_TONES else None


CONF_RANK = {"high": 3, "medium": 2, "low": 1}


def confidence_at_least(value, floor):
    return CONF_RANK.get((value or "").strip().lower(), 0) >= CONF_RANK.get(floor.lower(), 0)


def combine_presents(avatar, name):
    """The avatar wins -- normalize.ts:246."""
    if avatar in ("man", "woman", "not-a-person"):
        return avatar
    return "ambiguous" if name == "unknown" else name


def signals_disagree(avatar, name):
    return avatar in ("man", "woman") and name in ("man", "woman") and avatar != name


# ---------------------------------------------------------------------------
# port of sheet-task.ts extractJson / entriesFrom
# ---------------------------------------------------------------------------

def extract_entries(text):
    if not text:
        return []
    body = text
    fence = re.search(r"```(?:json)?\s*([\s\S]+?)```", body)
    if fence:
        body = fence.group(1)
    start = min([i for i in (body.find("{"), body.find("[")) if i != -1] or [-1])
    if start == -1:
        return []
    for end in range(len(body), start, -1):
        try:
            parsed = json.loads(body[start:end])
        except Exception:
            continue
        if isinstance(parsed, list):
            return [e for e in parsed if isinstance(e, dict)]
        if isinstance(parsed, dict):
            for key in ("entries", "rows", "data", "results"):
                if isinstance(parsed.get(key), list):
                    return [e for e in parsed[key] if isinstance(e, dict)]
            if "handle" in parsed:
                return [parsed]
        return []
    return []


# ---------------------------------------------------------------------------
# port of pipeline.service.ts nearDuplicate (sheet-local -- see the header)
# ---------------------------------------------------------------------------

def edit_distance_at_most_1(a, b):
    if a == b:
        return True
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(long) - len(short) > 1:
        return False
    i = 0
    while i < len(short) and short[i] == long[i]:
        i += 1
    if len(short) == len(long):
        return short[i + 1:] == long[i + 1:]
    return short[i:] == long[i + 1:]


def near_duplicate(handle, display_name, candidates):
    if len(handle) < 4 or not display_name:
        return None
    prefix = handle[:3]
    for c in candidates:
        if c["handle"] == handle or c["displayName"] != display_name:
            continue
        if not c["handle"].startswith(prefix):
            continue
        if abs(len(c["handle"]) - len(handle)) > 1:
            continue
        if edit_distance_at_most_1(c["handle"], handle):
            return c["handle"]
    return None


# ---------------------------------------------------------------------------
# the decision -- pipeline.service.ts:346, in the same order, keeping the reason
# ---------------------------------------------------------------------------

def decide(p, rule):
    """-> (forwarded, reason). The reason is what the server throws away."""
    if p["nearDuplicateOf"]:
        return False, f"near duplicate of @{p['nearDuplicateOf']}"
    if signals_disagree(p["avatarPresentsAs"], p["namePresentsAs"]):
        return False, (f"avatar reads {p['avatarPresentsAs']} but name reads "
                       f"{p['namePresentsAs']}")

    if rule["presentsAs"] and p["presentsAs"] not in rule["presentsAs"]:
        return False, f"presents as {p['presentsAs']}, rule wants {'/'.join(rule['presentsAs'])}"
    if not country_matches(rule["countries"], p["nationality"]):
        if not p["nationality"]:
            return False, ("no origin was read, and the rule names countries "
                           "without the 'none' sentinel")
        return False, f"origin {p['nationality']}, rule wants {'/'.join(rule['countries'])}"
    if rule["skinTones"]:
        tone = p["skinTone"]
        if not (tone and any(t.lower() == tone.lower() for t in rule["skinTones"])):
            return False, (f"tone {tone or 'unread'}, rule wants "
                           f"{'/'.join(rule['skinTones'])}")
    if p["nationality"] and not confidence_at_least(p["nationalityConf"], rule["minConfidence"]):
        return False, (f"origin reading is {p['nationalityConf'] or 'ungraded'}, "
                       f"rule floor is {rule['minConfidence']}")
    if rule["action"] != "forward":
        return False, f"matched a rule whose action is {rule['action']}"
    return True, f"{p['presentsAs']}, {p['nationality'] or 'no nationality read'}"


def resolve(entries):
    """port of pipeline.service.ts:213 -- entries to Person-shaped dicts."""
    rows, seen = [], set()
    for e in entries:
        handle = norm_handle(e.get("handle"))
        if not is_plausible_handle(handle) or handle in seen:
            continue
        seen.add(handle)
        avatar = to_presents(e.get("avatar_presents_as"))
        name = to_presents(e.get("name_presents_as") or e.get("presents_as"))
        rows.append({
            "handle": handle,
            "displayName": clean_display_name(e.get("display_name")),
            "presentsAs": combine_presents(avatar, name),
            "avatarPresentsAs": avatar,
            "namePresentsAs": name,
            "nationality": norm_country(e.get("nationality")),
            "nationalityConf": (e.get("nationality_confidence") or "").lower() or None,
            "skinTone": norm_skin_tone(e.get("skin_tone")),
            "cues": e.get("cues"),
            "nearDuplicateOf": None,
        })
    cands = []
    for r in rows:
        r["nearDuplicateOf"] = near_duplicate(r["handle"], r["displayName"], cands)
        cands.append({"handle": r["handle"], "displayName": r["displayName"]})
    return rows


# ---------------------------------------------------------------------------
# the live CRM
# ---------------------------------------------------------------------------

def crm_get(path, base, key):
    req = urllib.request.Request(f"{base}{path}", headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def operator_key(explicit=None):
    if explicit:
        return explicit
    if os.environ.get("OPERATOR_API_KEY"):
        return os.environ["OPERATOR_API_KEY"].strip()
    env = HERE.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPERATOR_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("no operator key: set OPERATOR_API_KEY or pass --key")


# ---------------------------------------------------------------------------
# the emulator
# ---------------------------------------------------------------------------

ADB = r"D:\LDPlayer\LDPlayer4.0\adb.exe"


def capture_sheet(serial, cols, out):
    """Reuse capture_live.py -- it already de-duplicates the scroll overlap."""
    cmd = [sys.executable, str(HERE / "capture_live.py"), "--out", out, "--cols", str(cols)]
    env = dict(os.environ, CAPTURE_SERIAL=serial)
    print(f"capturing from {serial} ...", flush=True)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    print(r.stdout or r.stderr)
    m = re.search(r"wrote (.+\.png)", r.stdout or "")
    if not m:
        raise SystemExit("capture_live.py did not report a sheet")
    return Path(m.group(1).strip())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sheet", help="an existing contact-sheet PNG")
    src.add_argument("--capture", action="store_true", help="scrape one off the emulator first")
    ap.add_argument("--serial", default="127.0.0.1:5557")
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--entries", type=int, default=None,
                    help="rows on the sheet; inferred from the filename if it says")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--crm", default=DEFAULT_CRM)
    ap.add_argument("--key", default=None, help="operator API key; defaults to ../.env")
    ap.add_argument("--rule-json", default=None, help="a rule to use instead of the live one")
    ap.add_argument("--apply", action="store_true",
                    help="ACT on the verdict on the emulator -- adds real people")
    ap.add_argument("--out", default="crm_verdict")
    a = ap.parse_args(argv)
    a.cols_given = any(x.startswith("--cols") for x in (argv or sys.argv[1:]))

    sheet = Path(capture_sheet(a.serial, a.cols, a.out + "_sheet")) if a.capture \
        else Path(a.sheet)
    if not sheet.exists():
        raise SystemExit(f"no such sheet: {sheet}")

    img = cv2.imread(str(sheet))
    if img is None:
        raise SystemExit(f"cannot read {sheet}")

    # The rule first: a run against a stale rule measures nothing.
    if a.rule_json:
        rule = json.loads(Path(a.rule_json).read_text(encoding="utf-8"))
    else:
        key = operator_key(a.key)
        rule = crm_get("/api/rules", a.crm, key)["rule"]
    print(f"rule: presentsAs={rule['presentsAs']} countries={rule['countries']} "
          f"skinTones={rule['skinTones']} minConfidence={rule['minConfidence']} "
          f"action={rule['action']} enabled={rule['enabled']}\n")

    # capture_live names its output `<tag>_<entries>e_<cols>c.png`, and the
    # prompt is built from both -- a sheet described as 99 rows in 3 columns
    # when it is 125 in 2 is a different task, not a smaller one.
    shape = re.search(r"_(\d+)e_(\d+)c", sheet.stem)
    n = a.entries or (int(shape.group(1)) if shape else 99)
    cols = a.cols if a.cols_given else (int(shape.group(2)) if shape else a.cols)
    prompt = sheet_prompt(n, cols)
    print(f"sheet  : {sheet.name} ({img.shape[1]}x{img.shape[0]})")
    print(f"model  : {a.model}")
    print(f"prompt : {len(prompt)} chars, lifted from sheet-task.ts\n")

    text, meta = apimart.Model(a.model).ask(prompt, [apimart.png_data_uri(img)])
    entries = extract_entries(text)
    people = resolve(entries)
    print(f"model returned {len(entries)} entries -> {len(people)} plausible handles "
          f"({meta.get('elapsed', 0):.0f}s)\n")

    forwarded, dropped, reasons = [], [], {}
    for p in people:
        ok, why = decide(p, rule)
        (forwarded if ok else dropped).append({**p, "reason": why})
        if not ok:
            head = why.split(",")[0].split(" and ")[0]
            reasons[head] = reasons.get(head, 0) + 1

    print(f"{'handle':<22}{'presents':<11}{'origin':<12}{'conf':<8}{'tone':<12}verdict")
    print("-" * 100)
    for p in people:
        ok, why = decide(p, rule)
        print(f"{('@' + p['handle'])[:21]:<22}{p['presentsAs']:<11}"
              f"{(p['nationality'] or '-')[:11]:<12}{(p['nationalityConf'] or '-'):<8}"
              f"{(p['skinTone'] or '-')[:11]:<12}"
              f"{'FORWARD' if ok else 'drop'}  {why}")

    print(f"\n{len(forwarded)} forwarded, {len(dropped)} dropped, of {len(people)}")
    print("\nwhy the drops happened:")
    for why, k in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {k:>4}  {why}")

    OUT.mkdir(parents=True, exist_ok=True)
    result = {"sheet": str(sheet), "model": a.model, "rule": rule,
              "counts": {"entries": len(entries), "people": len(people),
                         "forwarded": len(forwarded), "dropped": len(dropped)},
              "dropReasons": reasons,
              "forwarded": forwarded, "dropped": dropped, "raw": text}
    out = OUT / f"{a.out}.json"
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nwrote {out}")

    if a.apply:
        apply_to_emulator(forwarded, dropped, a.serial)
    else:
        print("\n--apply not given: nothing was touched on the emulator.")
    return 0


def apply_to_emulator(forwarded, dropped, serial):
    """Do to the roster what the agent would have, so a divergence is the agent's.

    Imported lazily and from the snap-automation checkout, because the add is
    steps.add_friend -- the same OCR-identified, button-watched add the agent
    uses. Reimplementing it here would measure this file instead of the client.
    """
    client = Path(r"C:\Users\Krisko\Desktop\snap-automation\src")
    if not client.exists():
        print(f"\n--apply: no snap-automation checkout at {client}")
        return
    sys.path.insert(0, str(client))
    try:
        from snapclient.device.control import Device
        from snapclient import emulator as emu
    except Exception as e:                                   # noqa: BLE001
        print(f"\n--apply: cannot import the client ({e!r})")
        return

    index = (int(serial.rsplit(":", 1)[1]) - 5555) // 2
    d = Device(index=index)
    if not d.ensure_online():
        print(f"--apply: instance {index} would not come online")
        return

    # follow_handle, NOT steps.add_friend: add_friend takes a row centre and
    # trusts the caller to have identified it, while follow_handle is the whole
    # production path -- OCR the visible rows, tap Add only on an exact read,
    # watch the button settle. Calling the inner one would test this file's
    # idea of where a row is, which is precisely the thing under suspicion.
    print(f"\napplying to instance {index}: "
          f"{len(forwarded)} to add, {len(dropped)} to dismiss")
    counts = {}
    for p in forwarded:
        outcome = emu.follow_handle(d, p["handle"])
        result = outcome[0] if isinstance(outcome, (tuple, list)) else outcome
        counts[result] = counts.get(result, 0) + 1
        print(f"  add @{p['handle']:<20} -> {outcome}")

    if dropped:
        # The same dismissal the agent does, so the next Quick Add refresh serves
        # new faces rather than the ones the rule already declined.
        hidden = emu.dismiss_remaining(d, [p["handle"] for p in dropped])
        print(f"  dismissed {hidden} of {len(dropped)} declined rows")

    print(f"\nadd outcomes: {counts}")
    print("A handle the rule FORWARDED that comes back anything but 'followed' "
          "is the automation's problem, not the CRM's -- that is the whole split "
          "this harness exists to make.")


if __name__ == "__main__":
    sys.exit(main())
