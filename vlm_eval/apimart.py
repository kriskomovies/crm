"""Client for the api.apimart.ai gateway (OpenAI-compatible /v1/chat/completions).

One gateway fronting ~277 models from every vendor, so a single code path can
compare Gemini, GPT, Claude, Qwen and Grok on the same image with the same
prompt. What varies between them is which optional parameters they tolerate,
so the request is built minimal and grows only when a model needs more.

The key is read from APIMART_KEY, falling back to the untracked file
`.apimart_key` next to this module. It is never written into results/.

    python apimart.py                     # list vision-ish models
    python apimart.py gemini-3-flash-preview   # one-shot smoke test
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2

BASE = "https://api.apimart.ai/v1"
HERE = Path(__file__).resolve().parent
KEY_FILE = HERE / ".apimart_key"
TIMEOUT = 300


def api_key():
    k = os.environ.get("APIMART_KEY")
    if k:
        return k.strip()
    if KEY_FILE.exists():
        return KEY_FILE.read_text(encoding="utf-8").strip()
    raise SystemExit(f"set APIMART_KEY or write the key to {KEY_FILE}")


def png_data_uri(img):
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("failed to encode image")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def jpeg_data_uri(img, quality=92):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("failed to encode image")
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


class HTTPFail(RuntimeError):
    def __init__(self, code, body):
        super().__init__(f"HTTP {code}: {body[:600]}")
        self.code, self.body = code, body


def _post(path, payload, key):
    """Send a chat request and return (text, info).

    This gateway answers `text/event-stream` whether or not streaming was asked
    for, so the reply has to be reassembled from SSE chunks rather than parsed
    as one JSON body. That turns out to be worth having: the timestamp of the
    first content chunk is time-to-first-token, which separates "the model is
    slow to start" from "the model has a lot to say" -- and for a 99-entry
    transcription those are very different costs.
    """
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}", "Accept": "text/event-stream"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            raw = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise HTTPFail(e.code, e.read().decode(errors="replace")) from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"{BASE}{path} unreachable: {e.reason}") from None
    elapsed = time.time() - t0

    if "event-stream" not in ctype:
        body = json.loads(raw)
        return _from_completion(body, elapsed)

    parts, reasoning, usage, finish, err = [], [], None, None, None
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(chunk.get("error"), dict):
            err = chunk["error"].get("message", "")
        if chunk.get("usage"):
            usage = chunk["usage"]
        for ch in chunk.get("choices") or []:
            finish = ch.get("finish_reason") or finish
            d = ch.get("delta") or ch.get("message") or {}
            c = d.get("content")
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, list):
                parts.extend(p.get("text", "") for p in c if isinstance(p, dict))
            if isinstance(d.get("reasoning_content"), str):
                reasoning.append(d["reasoning_content"])
    text = "".join(parts)
    if not text.strip() and err:
        raise RuntimeError(err[:300])
    return text, {"seconds": round(elapsed, 2), "finish_reason": finish,
                  "usage": usage or {},
                  "reasoning_chars": len("".join(reasoning)) or None}


def _from_completion(body, elapsed):
    if isinstance(body.get("error"), dict):
        raise RuntimeError(str(body["error"].get("message", ""))[:300])
    choice = (body.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    text = msg.get("content") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    return text, {"seconds": round(elapsed, 2),
                  "finish_reason": choice.get("finish_reason"),
                  "usage": body.get("usage") or {}, "reasoning_chars": None}


class Model:
    """One model behind the gateway.

    `quirks` records what had to be dropped to make a model answer at all --
    reasoning models reject temperature=0, some reject max_tokens -- so a
    parameter is only removed once, on the error that proves it unsupported,
    instead of being pre-emptively withheld from every model.
    """

    # 32000 to match server/src/extraction/gateway.client.ts, which uses
    # `o.maxTokens ?? 32000`. It was 16000 here, and that silently made this
    # harness measure a DIFFERENT configuration from the one production runs.
    #
    # It bit on 2026-08-04: gemini-3.6-flash, which had scored 99/99 on five
    # earlier runs, came back 91/99 with out=15996 -- four tokens under the cap.
    # gemini-3.5-flash and gemini-3-flash-preview reported the same 15996 and
    # 89/99 and 81/99. Three models with byte-identical output counts is a
    # ceiling, not three coincidences, and the salvage path made it look like an
    # accuracy result instead of a truncation.
    #
    # The models did not get worse; they think more than they used to. Earlier
    # gemini-3.6-flash runs landed at 11.6k-14.4k output tokens, so the headroom
    # that existed when the benchmark was written has since been spent.
    def __init__(self, model_id, temperature=0.0, max_tokens=32000, key=None):
        self.model_id = model_id
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.key = key or api_key()
        self.quirks = []

    def _payload(self, prompt, uris):
        content = [{"type": "text", "text": prompt}]
        for u in uris:
            content.append({"type": "image_url", "image_url": {"url": u}})
        p = {"model": self.model_id,
             "messages": [{"role": "user", "content": content}]}
        if "no-temperature" not in self.quirks and self.temperature is not None:
            p["temperature"] = self.temperature
        if "no-max-tokens" not in self.quirks and self.max_tokens:
            key = ("max_completion_tokens" if "max-completion-tokens" in self.quirks
                   else "max_tokens")
            p[key] = self.max_tokens
        return p

    def ask(self, prompt, uris, retries=2):
        """-> (text, meta). Raises only when the model cannot be made to answer."""
        last = None
        for attempt in range(retries + 1):
            try:
                text, info = _post("/chat/completions",
                                   self._payload(prompt, uris), self.key)
            except HTTPFail as e:
                last = e
                low = e.body.lower()
                # Learn the model's quirk from the complaint, then retry.
                if "temperature" in low and "no-temperature" not in self.quirks:
                    self.quirks.append("no-temperature")
                    continue
                if "max_completion_tokens" in low and "max-completion-tokens" not in self.quirks:
                    self.quirks.append("max-completion-tokens")
                    continue
                if "max_tokens" in low and "no-max-tokens" not in self.quirks:
                    self.quirks.append("no-max-tokens")
                    continue
                if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise
            except RuntimeError as e:
                last = e
                if attempt < retries:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise
            usage = info.pop("usage", {})
            meta = {**info,
                    "prompt_tokens": usage.get("prompt_tokens"),
                    "completion_tokens": usage.get("completion_tokens"),
                    "total_tokens": usage.get("total_tokens"),
                    "image_tokens": (usage.get("prompt_tokens_details") or {}).get("image_tokens"),
                    "quirks": list(self.quirks)}
            if not text.strip() and attempt < retries:
                last = RuntimeError(f"empty reply (finish={meta['finish_reason']})")
                continue
            return text, meta
        raise last or RuntimeError("no answer")


def list_models(key=None):
    req = urllib.request.Request(BASE + "/models",
                                 headers={"Authorization": f"Bearer {key or api_key()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return [m["id"] for m in json.loads(r.read().decode())["data"]]


if __name__ == "__main__":
    if len(sys.argv) > 1:
        import sheet
        img = sheet.crop_band(sheet.load_sheet(), 0, 2)
        m = Model(sys.argv[1])
        txt, meta = m.ask("List every name and @handle you can read in this image.",
                          [png_data_uri(img)])
        print(json.dumps(meta, indent=1))
        print(txt[:2000])
    else:
        for i in sorted(list_models()):
            print(i)
