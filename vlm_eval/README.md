# vlm_eval — measuring vision models on the Quick Add screenshots

Two harnesses share this directory and the same scoring key:

- **local models** (this file) — can a model running on this machine read the
  list well enough to be useful? Answer for Qwen2.5-VL 7B: yes for text, no for
  emoji, ~19s per screenful.
- **hosted models** ([APIMART.md](APIMART.md)) — 21 models behind the
  api.apimart.ai gateway, reading all 99 entries from one image. Answer:
  `gemini-3.6-flash` gets 99/99 handles and 99/99 names;
  `gemini-2.5-flash-lite` gets 97/99 in 11 seconds for $0.02 per 1000 profiles.
  That harness also produces the finished
  [roster with a name-origin guess](roster_with_nationality.md).

Harness for answering one question: **can a local vision model read the Snapchat
Quick Add list accurately enough to be useful here?**

Answer for Qwen2.5-VL 7B: **yes for text, no for emoji.** 99.4% character
accuracy on handles, ~19s per screenful, nothing invented across 122 rows — but
it drops emoji from display names almost every time. Numbers and failure modes in
[RESULTS.md](RESULTS.md); why the ChatGPT table it was going to be scored against
could not be used as-is is in [table_audit.md](table_audit.md).

That matters because `../read_usernames.py` currently does this job with
Tesseract, and only with Tesseract, because uiautomator refuses to expose the
name/`@handle` text (each row only publishes `avatar` and
`item_dismiss_button`). A vision model is the obvious alternative — but only if
it is actually more accurate, and that has to be measured rather than assumed.

## State of this machine (checked 2026-07-28)

| | |
|---|---|
| Ollama | **installed 2026-07-28** to `D:\Ollama` (v0.32.5), models in `D:\ollama-models`, serving on `:11434`. Installed to D: deliberately — C: has too little headroom |
| LM Studio / llama.cpp / GGUF weights | none |
| WSL | optional component not enabled; `D:\WSL\Ubuntu.tar` was never imported |
| Docker | installed, daemon not running |
| Tesseract | **not installed either** — so `../read_usernames.py` cannot run as written |
| torch / transformers | installed but **broken**, see below |
| GPU | RTX 3070 Ti, 8 GB VRAM — currently unreachable from Python |
| Disk | C: 9 GB free, D: 127 GB free — put model weights on D: |

The Python ML stack looks usable in `pip list` and is not:

- `torch` is **2.9.0+cpu**, a CPU-only build. `torch.cuda.is_available()` returns
  `False`, so the 3070 Ti cannot be used from this interpreter at all.
- `torchvision 0.23.0+cu126` and `torchaudio 2.8.0+cu126` are CUDA builds for
  torch **2.8**. Against torch 2.9 the ABI does not line up, so
  `import torchvision` raises `RuntimeError: operator torchvision::nms does not
  exist` — and because transformers imports torchvision, **`from transformers
  import AutoProcessor` fails outright.**

So the `hf:` backend needs the torch stack repaired before it can run anything:

```bash
python -m pip install --force-reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu126
```

That is a ~2.5 GB download and it will also disturb whatever currently depends on
these packages. **Ollama is the lower-risk route** — it ships its own CUDA
runtime, touches no Python, and leaves the existing stack alone.

ComfyUI is unaffected either way; the Electron app bundles its own Python and
does not share this environment.

Wherever the weights land, keep them off C: — 9 GB free is not enough:

```bash
setx HF_HOME "D:\hf-cache"
```

## Layout

| file | does |
|---|---|
| `rows.py` | row geometry + per-row cropping; `python rows.py` dumps every crop to `crops/` |
| `tasks.py` | the prompts, and the JSON extractor that digs an object out of a chatty reply |
| `providers.py` | `hf:` (in-process transformers), `ollama:`, `openai:` (LM Studio / llama.cpp / vLLM) |
| `run_eval.py` | runs a model over the pages, writes raw replies to `results/` |
| `score.py` | scores `results/*.json` against `ground_truth.json` |
| `zoom.py`, `zoom_text.py` | upscale one avatar or one name strip, for settling attribute calls by eye |
| `ground_truth.json` | the scoring key — see the caveat below |

Collection and scoring are separate on purpose: a slow run is never wasted, and
predictions can be re-scored whenever the key is corrected.

## The two things being measured

**`read`** — transcribe `display_name` and `handle`. Objectively checkable
against the pixels; exactly one right answer per field. This is the task that
actually matters for this repo.

**`avatar`** — describe the drawn Bitmoji (facial hair, headwear, eyewear, hair
colour, cartoon skin tone, how the cartoon presents). Note the framing: these
are questions about *a drawing the account holder picked*, not about the person
behind the account. A Bitmoji's skin tone is a customisation setting, so "did
the model read the avatar correctly" is answerable and gradeable, while "did the
model read the human correctly" is not. Only the former is scored.

## Page vs row mode

`--mode page` sends one 900×1600 screenshot and asks for 14 rows back.
`--mode row` sends 14 crops of ~660×100 and asks for one row each.

Both are supported because the gap between them is usually large — small models
that fail completely on the full page often do fine on a single row — and that
gap decides whether this approach is viable at all. Run both before concluding
anything about a model.

## Running

```bash
python run_eval.py --provider hf:Qwen/Qwen2.5-VL-3B-Instruct --mode row --task both
```

```bash
python score.py
```

Other backends:

```bash
python run_eval.py --provider ollama:qwen2.5vl:7b --mode page
```

```bash
python run_eval.py --provider openai:local-model --base http://localhost:1234 --mode row
```

`--4bit` quantises an `hf:` model so a 7B fits in 8 GB of VRAM.

## Caveat on `ground_truth.json`

One correction has been applied since the key was first built: entry 38's handle
is `towmaterrrrrrrr` with **eight** trailing `r`s, not seven. Seven hosted models
read it that way, and counting connected ink runs in the handle line confirms 15
glyphs. When independent models agree against a hand-keyed answer, check the key.

The key was built by reading the pixels directly at high zoom, **not** by
trusting the ChatGPT table that prompted this work. That table is mostly right
but contains transcription errors — it renders `Sam Clarckson` as the more
common `Sam Clarkson`, and drops the 🇹🇷 from `Kurt Bey🦊🇹🇷` — so scoring a
model against it would penalise the model for being right. See
`table_audit.md`.

Two of that table's columns are also not scoreable and are deliberately absent
here: *likely gender* and *name-origin best guess* are inferences about real
people drawn from a chosen cartoon and a username. There is no fact in the
screenshot to check them against, so a percentage computed over them would not
mean anything. What is in the key instead is `gender_presentation` — how the
cartoon is drawn — which is checkable.
