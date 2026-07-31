"""Backends that can answer a question about an image.

Three are supported, in rough order of how much they cost to set up:

  hf      transformers running the model in-process. transformers 4.57 is
          installed but NOT currently importable on this machine: torch is a
          CPU-only 2.9 build sitting next to cu126 torchvision/torchaudio built
          for 2.8, and the ABI mismatch breaks `import torchvision`, which
          transformers imports. Repair the torch stack before using this
          backend -- see README.md.
  ollama  HTTP to a running `ollama serve` (default :11434).
  openai  HTTP to anything speaking /v1/chat/completions with image_url content:
          LM Studio, llama.cpp's server, vLLM, or a hosted API.

Every provider takes (prompt, [images]) and returns raw text. Parsing that text
into JSON is the caller's problem, deliberately: how badly a model mangles the
requested output format is one of the things we are measuring.
"""
import base64
import json
import os
import urllib.error
import urllib.request

import cv2

TIMEOUT = 600  # a 3B model on a busy 3070 Ti can take a while for the first token


def _png_b64(img):
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("failed to encode image")
    return base64.b64encode(buf.tobytes()).decode()


def _post(url, payload, headers=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{url} -> HTTP {e.code}: {e.read().decode()[:400]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"{url} unreachable: {e.reason}") from None


class Ollama:
    def __init__(self, model, host="http://localhost:11434", temperature=0):
        self.model, self.host, self.temperature = model, host, temperature

    def name(self):
        return f"ollama/{self.model}"

    def ask(self, prompt, images):
        r = _post(f"{self.host}/api/chat", {
            "model": self.model,
            "stream": False,
            "options": {"temperature": self.temperature},
            "messages": [{
                "role": "user",
                "content": prompt,
                "images": [_png_b64(i) for i in images],
            }],
        })
        return r["message"]["content"]


class OpenAICompatible:
    def __init__(self, model, base="http://localhost:1234", api_key=None, temperature=0):
        self.model, self.base, self.temperature = model, base.rstrip("/"), temperature
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "not-needed")

    def name(self):
        return f"openai/{self.model}"

    def ask(self, prompt, images):
        content = [{"type": "text", "text": prompt}]
        for img in images:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{_png_b64(img)}"},
            })
        r = _post(
            f"{self.base}/v1/chat/completions",
            {"model": self.model, "temperature": self.temperature,
             "messages": [{"role": "user", "content": content}]},
            {"Authorization": f"Bearer {self.api_key}"},
        )
        return r["choices"][0]["message"]["content"]


class HuggingFace:
    """In-process transformers. Weights land in HF_HOME -- point that at D: if C:
    is tight, because these are multi-GB downloads."""

    def __init__(self, model, temperature=0, load_4bit=False):
        self.model_id, self.temperature, self.load_4bit = model, temperature, load_4bit
        self._proc = self._model = None

    def name(self):
        return f"hf/{self.model_id}" + ("+4bit" if self.load_4bit else "")

    def _load(self):
        if self._model is not None:
            return
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        kw = {"dtype": torch.float16, "device_map": "auto"}
        if self.load_4bit:
            from transformers import BitsAndBytesConfig
            kw["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_quant_type="nf4",
            )
        self._proc = AutoProcessor.from_pretrained(self.model_id)
        self._model = AutoModelForImageTextToText.from_pretrained(self.model_id, **kw)
        self._model.eval()

    def ask(self, prompt, images):
        import torch
        from PIL import Image

        self._load()
        pil = [Image.fromarray(cv2.cvtColor(i, cv2.COLOR_BGR2RGB)) for i in images]
        content = [{"type": "image"} for _ in pil] + [{"type": "text", "text": prompt}]
        text = self._proc.apply_chat_template(
            [{"role": "user", "content": content}],
            add_generation_prompt=True, tokenize=False,
        )
        inputs = self._proc(text=[text], images=pil, return_tensors="pt").to(self._model.device)
        with torch.inference_mode():
            out = self._model.generate(
                **inputs, max_new_tokens=1024,
                do_sample=self.temperature > 0, temperature=self.temperature or None,
            )
        # generate() returns prompt + completion; keep only what the model added.
        new = out[0][inputs["input_ids"].shape[1]:]
        return self._proc.decode(new, skip_special_tokens=True)


def build(spec, **kw):
    """Build a provider from a "backend:model" string, e.g. "ollama:qwen2.5vl:7b"."""
    backend, _, model = spec.partition(":")
    if not model:
        raise SystemExit(f'provider must be "backend:model", got {spec!r}')
    if backend == "ollama":
        return Ollama(model, **{k: v for k, v in kw.items() if k in ("host", "temperature")})
    if backend == "openai":
        return OpenAICompatible(model, **{k: v for k, v in kw.items()
                                          if k in ("base", "api_key", "temperature")})
    if backend == "hf":
        return HuggingFace(model, **{k: v for k, v in kw.items()
                                     if k in ("temperature", "load_4bit")})
    raise SystemExit(f"unknown backend {backend!r} (want ollama, openai, or hf)")
