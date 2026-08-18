"""The two models side by side on the production prompt (arm A of ab_origin).

ab_origin.py answered "should the avatar inform nationality". This answers the
other question it happened to collect the data for: is the cheap model a safe
drop-in for the one in production, judged on every field the server actually
stores.

Transcription is scored separately from judgement because they are different
kinds of claim -- a handle has one right answer and can be checked against the
pixels, while whether a face reads as a man is a reading, and for those the only
available evidence is whether two independent models arrived at the same place.
"""
import json
import pathlib

R = pathlib.Path(__file__).resolve().parent / "results"
A_ID, B_ID = "gemini-3-flash-preview-nothinking", "gemini-3.6-flash"
FIELDS = [("nationality", "nationality"),
          ("nationality_confidence", "confidence"),
          ("avatar_presents_as", "avatar presents"),
          ("name_presents_as", "name presents"),
          ("skin_tone", "skin tone")]
N = 33


def load(mid):
    d = json.loads((R / f"ab_{mid}_A.json").read_text(encoding="utf-8"))
    return {e["n"]: e for e in d["entries"]}, d


def norm(s):
    return (s or "").strip().lower()


a, da = load(A_ID)
b, db = load(B_ID)

print(f"production prompt, {N} entries\n  A = {A_ID}\n  B = {B_ID}\n")

print(f"{'':>3} {'display name (A)':<24}{'handle (A)':<18}{'handle (B)':<18}")
print("-" * 66)
nmis = hmis = 0
for n in range(1, N + 1):
    x, y = a.get(n, {}), b.get(n, {})
    ha, hb = norm(x.get("handle")), norm(y.get("handle"))
    na, nb = norm(x.get("display_name")), norm(y.get("display_name"))
    hmis += ha != hb
    nmis += na != nb
    print(f"{n:>3} {(x.get('display_name') or '')[:23]:<24}{ha[:17]:<18}"
          f"{(hb[:17] if ha != hb else ''):<18}"
          f"{'' if ha == hb else '<- differs'}")
print(f"\nhandles identical      {N - hmis}/{N}")
print(f"display names identical {N - nmis}/{N}  "
      f"(emoji rendering accounts for most of any gap)")

rows = []
for fld, label in FIELDS:
    agree = 0
    print(f"\n{label}")
    print(f"{'':>3} {'name':<24}{'A':<16}{'B':<16}")
    print("-" * 60)
    for n in range(1, N + 1):
        x, y = a.get(n, {}), b.get(n, {})
        va, vb = norm(x.get(fld)), norm(y.get(fld))
        agree += va == vb
        print(f"{n:>3} {(x.get('display_name') or '')[:23]:<24}"
              f"{va[:15]:<16}{vb[:15]:<16}{'' if va == vb else '<-'}")
    print(f"  agree {agree}/{N} ({agree / N:.0%})")
    rows.append((label, agree))

print(f"\n{'field':<20}{'agreement':>12}")
print("-" * 32)
print(f"{'handle':<20}{f'{N - hmis}/{N}':>12}")
for label, agree in rows:
    print(f"{label:<20}{f'{agree}/{N}':>12}")

print(f"\n{'model':<38}{'sec':>7}{'in':>7}{'out':>7}{'$/sheet':>10}{'$/1000':>9}")
print("-" * 78)
for d in (da, db):
    u = d["measured_usd"]
    print(f"{d['model']:<38}{d['seconds']:>7.1f}{d['prompt_tokens']:>7}"
          f"{d['completion_tokens']:>7}{('$%.5f' % u):>10}"
          f"{('$%.3f' % (u / N * 1000)):>9}")
print(f"\ncost ratio {db['measured_usd'] / da['measured_usd']:.1f}x  "
      f"| output tokens {db['completion_tokens'] / da['completion_tokens']:.1f}x "
      f"for the same JSON")
