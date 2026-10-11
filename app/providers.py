"""Server-side inference adapters. Provider URLs/tokens live only in server env, never in the browser.

Config per adapter key (e.g. OCR_KTP):
  LUTUNG_PROVIDER_OCR_KTP_URL    e.g. https://api.runpod.ai/v2/<endpoint-id>/runsync  ("mock" for local dev)
  LUTUNG_PROVIDER_OCR_KTP_TOKEN  provider API key

Assumed contract (RunPod runsync): POST {"input": {"image": <base64>}} -> {"status": "COMPLETED", "output": {...}}.
Confirm the real request/response shape in Phase 0 discovery and adjust only this file.
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
}


async def run(adapter_key, image_bytes, timeout_s):
    env = f"LUTUNG_PROVIDER_{adapter_key.upper()}"
    url, token = os.getenv(f"{env}_URL"), os.getenv(f"{env}_TOKEN", "")
    if url == "mock":
        return MOCK_OUTPUT.get(adapter_key, {"_mock": True})
    if not url:
        raise ProviderError("SERVICE_UNAVAILABLE")
    payload = {"input": {"image": base64.b64encode(image_bytes).decode()}}
    # No automatic retries: inference is non-idempotent and may cost money.
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.post(url, json=payload, headers={"Authorization": f"Bearer {token}"})
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
    if not isinstance(output, dict) or output.get("error"):
        raise ProviderError("SERVICE_UNAVAILABLE")
    return output
