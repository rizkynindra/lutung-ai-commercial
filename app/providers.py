"""Server-side inference adapters. Provider URLs/tokens live only in server env, never in the browser.

Config per adapter key (e.g. OCR_KTP, QWEN_IMAGE):
  LUTUNG_PROVIDER_OCR_KTP_URL    e.g. https://api.runpod.ai/v2/<endpoint-id>/runsync  ("mock" for local dev)
  LUTUNG_PROVIDER_OCR_KTP_TOKEN  provider API key

Document adapters POST {"input": {"image": <base64>}}.
Qwen Image POSTs {"input": {mode, prompt, width, height, steps, seed}}.
Edit and transparent modes also send input.image as raw base64.
RunPod runsync answers {"status": "COMPLETED", "output": ...}.
"""
import base64
import os

import httpx


class ProviderError(Exception):
    def __init__(self, code):  # SERVICE_UNAVAILABLE | PROCESSING_TIMEOUT
        super().__init__(code)
        self.code = code


MOCK_OUTPUT = {
    "document_detection": {"_mock": True, "note": "Mock output for local development"},
    "ocr_ktp": {"_mock": True, "nik": "0000000000000000", "nama": "CONTOH NAMA", "tanggal_lahir": "01-01-1990"},
    "qwen_image": {
        "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "seed": 1,
    },
}

# Top-level keys that hold a generated picture. Nested data/url are read only inside those.
_IMAGE_KEYS = ("image", "images", "image_base64", "image_url")
_INNER_KEYS = ("image", "images", "image_base64", "image_url", "data", "base64", "url")


def _looks_b64(value):
    if len(value) < 40 or len(value) > 20_000_000:
        return False
    return value.startswith(("/9j/", "iVBORw0KGgo", "UklGR", "R0lGOD"))


def _find_image(value, depth=0, trusted=False):
    if depth > 4 or value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("data:image/"):
            return text
        if text.startswith("https://") and len(text) < 2000 and " " not in text:
            return text
        compact = "".join(text.split())
        if (trusted or _looks_b64(compact)) and len(compact) >= 40:
            return compact
        return None
    if isinstance(value, list):
        for item in value[:4]:
            found = _find_image(item, depth + 1, trusted)
            if found:
                return found
        return None
    if isinstance(value, dict):
        keys = _INNER_KEYS if trusted else _IMAGE_KEYS
        for key in keys:
            if key in value:
                found = _find_image(value[key], depth + 1, True)
                if found:
                    return found
    return None


def _image_src(value):
    if value.startswith(("data:image/", "https://")):
        return value
    mime = "image/png"
    if value.startswith("/9j/"):
        mime = "image/jpeg"
    elif value.startswith("R0lGOD"):
        mime = "image/gif"
    elif value.startswith("UklGR"):
        mime = "image/webp"
    return f"data:{mime};base64,{value}"


def present(output):
    """Client-safe generate result. Drops raw image blobs from the JSON fields."""
    found = _find_image(output)
    data = {}
    if found:
        data["image"] = _image_src(found)
    if isinstance(output, dict):
        for key, value in output.items():
            if key in _IMAGE_KEYS:
                continue
            if isinstance(value, (int, float, bool)) or value is None:
                data[key] = value
            elif isinstance(value, str) and len(value) <= 200 and not value.startswith("data:image/"):
                data[key] = value
    return data


async def _call(adapter_key, payload, timeout_s):
    env = f"LUTUNG_PROVIDER_{adapter_key.upper()}"
    url, token = os.getenv(f"{env}_URL"), os.getenv(f"{env}_TOKEN", "")
    if url == "mock":
        return MOCK_OUTPUT.get(adapter_key, {"_mock": True})
    if not url:
        raise ProviderError("SERVICE_UNAVAILABLE")
    # No automatic retries: inference is non-idempotent and may cost money.
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.post(url, json={"input": payload}, headers={"Authorization": f"Bearer {token}"})
    except httpx.TimeoutException:
        raise ProviderError("PROCESSING_TIMEOUT")
    except httpx.HTTPError:
        raise ProviderError("SERVICE_UNAVAILABLE")
    if r.status_code != 200:
        raise ProviderError("SERVICE_UNAVAILABLE")
    try:
        body = r.json()
    except ValueError:
        raise ProviderError("SERVICE_UNAVAILABLE")
    status = body.get("status") if isinstance(body, dict) else None
    if status in ("IN_QUEUE", "IN_PROGRESS"):
        raise ProviderError("PROCESSING_TIMEOUT")
    output = body.get("output") if status == "COMPLETED" else None
    if output is None or (isinstance(output, dict) and output.get("error")):
        raise ProviderError("SERVICE_UNAVAILABLE")
    return output


async def run(adapter_key, image_bytes, timeout_s):
    output = await _call(adapter_key, {"image": base64.b64encode(image_bytes).decode()}, timeout_s)
    if not isinstance(output, dict):
        raise ProviderError("SERVICE_UNAVAILABLE")
    return output


async def run_generate(adapter_key, fields, timeout_s):
    return present(await _call(adapter_key, fields, timeout_s))
