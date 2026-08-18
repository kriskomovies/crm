"""Can skin tone be read from pixels instead of bought from a VLM?

palette_probe.py answered the first question and the answer was NO: 85 distinct
face colours across 92 avatars, so there is no fixed palette to look up. But that
number is misleading on its own -- #FEE2AE, #FFE1AC, #FFE3AF and #FFE1AE are one
fill with +/-2 of resampling jitter, not four palette entries. Exact match is
simply the wrong comparison for a continuous quantity.

Skin tone is ORDINAL (score.py: SKIN_SCALE, pale..dark-brown), so the question
that actually decides it is whether the sampled colour ORDERS the same way the
hand-keyed tone does. If it does, thresholds work and no model is needed. If it
does not, the sampling is picking up hair and the idea is dead.

Reported honestly: the rank correlation is the real signal, and the classifier
accuracy below it is fitted on the same 99 avatars it is scored on, so it is an
in-sample CEILING, not an expected accuracy. Adjacent-bucket agreement is shown
because score.py already argues the boundary is fuzzy -- two human readers
disagreed on 8 of these 99.

    D:\\ocr-venv\\Scripts\\python.exe tone_eval.py
"""
import collections
import io
import json
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
PROBE = HERE / "results" / "palette_probe.json"

# score.py's ordinal scale. Off-scale values are categorical, not shades.
SCALE = ["pale", "light", "light-tan", "medium-tan", "tan", "brown", "dark-brown"]
OFF_SCALE = {"placeholder", "stylised"}


def luminance(bgr):
    b, g, r = bgr
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):           # average ties
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = rank(xs), rank(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    return num / (dx * dy) if dx and dy else 0.0


def main():
    rows = json.loads(PROBE.read_text(encoding="utf-8"))

    keyed = collections.Counter(r["skin_tone"] for r in rows)
    print("keyed tone distribution over 99 avatars:")
    for tone, n in keyed.most_common():
        print(f"  {str(tone)[:52]:<54}{n:>3}")

    # Only on-scale, successfully-sampled avatars can be ordered.
    usable = [r for r in rows
              if r["bgr"] and r["skin_tone"] in SCALE]
    unsampled = [r for r in rows if not r["bgr"]]
    print(f"\nsampled: {len(rows) - len(unsampled)}/99   "
          f"on-scale and sampled: {len(usable)}")

    lum = [luminance(r["bgr"]) for r in usable]
    ordinal = [SCALE.index(r["skin_tone"]) for r in usable]
    rho = spearman(lum, ordinal)
    print(f"\nSpearman(luminance, keyed tone) = {rho:+.3f}")
    print("  expected strongly NEGATIVE: darker pixels = later on the scale.")

    # Mean luminance per keyed tone -- is the ordering even monotonic?
    print(f"\n{'keyed tone':<14}{'n':>4}{'mean luminance':>16}{'min':>7}{'max':>7}")
    print("-" * 48)
    for tone in SCALE:
        vals = [luminance(r["bgr"]) for r in usable if r["skin_tone"] == tone]
        if vals:
            print(f"{tone:<14}{len(vals):>4}{sum(vals) / len(vals):>16.1f}"
                  f"{min(vals):>7.0f}{max(vals):>7.0f}")

    # In-sample ceiling: nearest class mean on luminance alone.
    means = {}
    for tone in SCALE:
        vals = [luminance(r["bgr"]) for r in usable if r["skin_tone"] == tone]
        if vals:
            means[tone] = sum(vals) / len(vals)
    exact = adjacent = 0
    for r in usable:
        L = luminance(r["bgr"])
        pred = min(means, key=lambda t: abs(means[t] - L))
        d = abs(SCALE.index(pred) - SCALE.index(r["skin_tone"]))
        exact += d == 0
        adjacent += d <= 1
    n = len(usable)
    print(f"\nnearest-class-mean on luminance (IN-SAMPLE ceiling, n={n}):")
    print(f"  exact            {exact}/{n}  ({exact / n:.0%})")
    print(f"  within 1 bucket  {adjacent}/{n}  ({adjacent / n:.0%})")

    # The sampler's own failures: dark pixels keyed as the lightest tones means
    # the mask found hair or a beard, not a face.
    print("\nclearly mis-sampled (keyed pale/light but very dark pixels):")
    bad = [r for r in usable
           if r["skin_tone"] in ("pale", "light") and luminance(r["bgr"]) < 140]
    for r in sorted(bad, key=lambda r: luminance(r["bgr"])):
        print(f"  n{r['n']:<4}{r['hex']}  lum {luminance(r['bgr']):>5.0f}  "
              f"keyed {r['skin_tone']:<12}@{r['handle']}")
    print(f"  -> {len(bad)} of {n} on-scale samples are the mask picking hair")


if __name__ == "__main__":
    main()
