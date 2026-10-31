"""LUTUNG AI portal: public pages + backend/BFF for playgrounds, trials and API docs."""
import asyncio
import io
import json
import logging
import os
import sys
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image

from app import auth, db, providers

BASE = Path(__file__).parent
REGISTRY_PATH = Path(os.getenv("LUTUNG_REGISTRY", BASE / "registry.json"))
NOTICE_VERSION = "2026-10-v1"
DISABLED = {s.strip() for s in os.getenv("LUTUNG_DISABLED", "").split(",") if s.strip()}  # ops kill switch
LIVE = {"available", "beta"}

logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s")
_log = logging.getLogger("lutung")


def log(**fields):
    """Structured log. Never pass file bytes, OCR output, tokens or PII here."""
    _log.info(json.dumps({"ts": round(time.time(), 3), **fields}))


def registry():
    # Re-read on every call so an operator can edit status (e.g. "maintenance") without a restart.
    techs = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    for t in techs:
        if t["slug"] in DISABLED and t["status"] in LIVE:
            t["status"] = "maintenance"
    return techs


def get_tech(slug):
    return next((t for t in registry() if t["slug"] == slug), None)


def public(t):
    return {k: v for k, v in t.items() if k != "adapter"}


app = FastAPI(title="LUTUNG AI", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")
templates.env.globals.update(
    firebase=auth.web_config(),
    dev_auth=auth.DEV_AUTH, notice_version=NOTICE_VERSION,
    status_label={"available": "Tersedia", "beta": "Beta", "coming_soon": "Segera Hadir",
                  "maintenance": "Pemeliharaan", "unavailable": "Tidak Tersedia"},
    access_label={"free": "Gratis", "trial": "1x uji coba gratis", "none": "Segera Hadir"},
    live=LIVE,
    asset_v=lambda: int(max(f.stat().st_mtime for f in (BASE / "static").iterdir())),  # cache-busting
)
db.init()


@app.middleware("http")
async def request_context(request: Request, call_next):
    rid = "req_" + uuid.uuid4().hex[:16]
    request.state.rid = rid
    start = time.time()
    try:
        response = await call_next(request)
    except Exception as e:  # never leak stack traces to the client
        log(event="unhandled_error", request_id=rid, path=request.url.path, error=type(e).__name__)
        response = err(rid, "INTERNAL_ERROR", "Unexpected server error.", 500)
    response.headers["X-Request-Id"] = rid
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    log(event="http", request_id=rid, method=request.method, path=request.url.path,
        status=response.status_code, latency_ms=int((time.time() - start) * 1000))
    return response


def err(rid, code, message, status, headers=None):
    return JSONResponse({"request_id": rid, "error": {"code": code, "message": message}}, status, headers=headers)


# ---------- abuse controls ----------
# ponytail: in-process limiter/semaphores; move to Redis when running more than one backend instance.
_hits = defaultdict(deque)
_sems = {}


def rate_limited(key, per_min):
    now, q = time.time(), _hits[key]
    while q and q[0] < now - 60:
        q.popleft()
    if len(q) >= per_min:
        return int(q[0] + 60 - now) + 1
    q.append(now)
    return 0


def validate_image(data, limits):
    """Return (metadata, None) or (None, (code, message, status)). Never trusts client MIME/filename."""
    if not data:
        return None, ("INVALID_FILE", "Empty upload.", 400)
    if len(data) > limits["max_bytes"]:
        return None, ("FILE_TOO_LARGE", f"File exceeds {limits['max_bytes'] // 1048576} MB.", 413)
    try:
        img = Image.open(io.BytesIO(data))
        fmt, (w, h) = img.format, img.size
        if fmt not in limits["formats"]:
            return None, ("INVALID_FILE", f"Supported formats: {', '.join(limits['formats'])}.", 400)
        if w * h > limits["max_pixels"]:
            return None, ("FILE_TOO_LARGE", "Image dimensions are too large.", 413)
        img.load()  # full decode: rejects truncated/malformed files
    except Exception:
        return None, ("INVALID_FILE", "File is not a valid image.", 400)
    return {"format": fmt, "bytes": len(data), "width": w, "height": h}, None


def current_user(request):
    ident = auth.verify(request.headers.get("authorization"))
    user = db.upsert_user(ident["provider"], ident["subject"], ident["email"], ident["name"])
    user["admin"] = auth.is_admin(ident)
    return user


# ---------- API ----------

@app.get("/api/v1/health")
def health():
    return {"status": "ok", "services": {t["slug"]: t["status"] for t in registry()}}


@app.get("/api/v1/technologies")
def technologies():
    return [public(t) for t in registry()]


@app.get("/api/v1/technologies/{slug}")
def technology(slug: str, request: Request):
    t = get_tech(slug)
    return public(t) if t else err(request.state.rid, "NOT_FOUND", "Unknown technology.", 404)


@app.get("/api/v1/me")
def me(request: Request):
    try:
        user = current_user(request)
    except auth.AuthError:
        return err(request.state.rid, "UNAUTHORIZED", "Sign in again.", 401)
    trials = {t["slug"]: db.trial_status(user["id"], t["slug"]) for t in registry() if t.get("access_mode") == "trial"}
    return {"email": user["email"], "display_name": user["display_name"], "trials": trials,
            "admin": user["admin"], "consent": db.has_consent(user["id"], NOTICE_VERSION)}


@app.post("/api/v1/consent")
async def consent(request: Request):
    try:
        user = current_user(request)
    except auth.AuthError:
        return err(request.state.rid, "UNAUTHORIZED", "Sign in again.", 401)
    body = await request.json()
    if body.get("notice_version") != NOTICE_VERSION:
        return err(request.state.rid, "INVALID_REQUEST", "Unknown notice version.", 400)
    db.add_consent(user["id"], NOTICE_VERSION)
    return {"ok": True}


@app.post("/api/v1/feedback")
async def feedback(request: Request):
    rid = request.state.rid
    try:
        user = current_user(request)
    except auth.AuthError:
        return err(rid, "UNAUTHORIZED", "Sign in again.", 401)
    body = await request.json()
    msg = str(body.get("message", "")).strip()[:2000]
    if not msg or not get_tech(str(body.get("technology", ""))):
        return err(rid, "INVALID_REQUEST", "Message and technology are required.", 400)
    context = str(body.get("context", ""))[:500]
    db.add_feedback(user["id"], body["technology"], str(body.get("request_id", ""))[:64], f"{msg}\n\n[context] {context}")
    return {"ok": True}


@app.post("/api/v1/playground/{slug}")
async def playground_run(slug: str, request: Request):
    rid, started = request.state.rid, time.time()
    t = get_tech(slug)
    if not t or not t.get("playground_enabled"):
        return err(rid, "NOT_FOUND", "No playground for this technology.", 404)
    if t["status"] not in LIVE:
        return err(rid, "SERVICE_UNAVAILABLE", "Service is not accepting requests right now.", 503)
    try:
        user = current_user(request)
    except auth.AuthError:
        return err(rid, "UNAUTHORIZED", "Sign in again.", 401)
    limits = t["limits"]

    ip = request.client.host if request.client else "?"
    wait = rate_limited(f"u:{user['id']}:{slug}", limits["rate_per_min"]) or \
        rate_limited(f"ip:{ip}:{slug}", limits["rate_per_min"] * 3)
    if wait:
        return err(rid, "RATE_LIMITED", "Too many requests. Please try again later.", 429, {"Retry-After": str(wait)})

    # Cap the body before parsing so huge uploads are never spooled.
    length = request.headers.get("content-length")
    if not length or not length.isdigit():
        return err(rid, "INVALID_FILE", "Content-Length required.", 411)
    if int(length) > limits["max_bytes"] + 65536:
        return err(rid, "FILE_TOO_LARGE", f"File exceeds {limits['max_bytes'] // 1048576} MB.", 413)
    if not request.headers.get("content-type", "").startswith("multipart/form-data"):
        return err(rid, "INVALID_FILE", "Use multipart/form-data with a 'file' field.", 415)
    form = await request.form(max_files=1, max_fields=2)
    upload = form.get("file")
    data = await upload.read() if hasattr(upload, "read") else b""
    if hasattr(upload, "close"):
        await upload.close()  # deletes any spooled temp file
    meta, problem = validate_image(data, limits)
    if problem:
        db.record_execution(rid, user["id"], slug, "rejected", started, problem[0])
        return err(rid, *problem)

    if t.get("sensitive") and not db.has_consent(user["id"], NOTICE_VERSION):
        return err(rid, "CONSENT_REQUIRED", "Acknowledge the data-handling notice first.", 403)

    sem = _sems.setdefault(slug, asyncio.Semaphore(limits["concurrency"]))
    if sem.locked():
        return err(rid, "SERVICE_UNAVAILABLE", "Service is busy. Please retry shortly.", 503, {"Retry-After": "10"})

    # Admins skip the one-success trial cap. Per-minute rate limits above still apply.
    trial = t["access_mode"] == "trial" and not user["admin"]
    if trial:
        state = db.reserve_trial(user["id"], slug, rid, lease_s=limits["timeout_s"] + 60)
        if state == "CONSUMED":
            db.record_execution(rid, user["id"], slug, "blocked", started, "TRIAL_ALREADY_USED")
            return err(rid, "TRIAL_ALREADY_USED",
                       "Free trial already used. Paid access is not available yet; contact the team for pilot access.", 403)
        if state == "IN_PROGRESS":
            return err(rid, "TRIAL_IN_PROGRESS", "A trial request is already processing.", 409)

    meta_json = json.dumps(meta)
    async with sem:
        try:
            output = await providers.run(t["adapter"], data, limits["timeout_s"])
        except providers.ProviderError as e:
            if trial:
                db.settle_trial(user["id"], slug, rid, False, e.code)
            db.record_execution(rid, user["id"], slug, "failed", started, e.code, meta_json)
            log(event="playground", request_id=rid, technology=slug, outcome="failed", error=e.code,
                admin=user["admin"])
            msg = "Processing timed out." if e.code == "PROCESSING_TIMEOUT" else "Service unavailable. Retry later."
            return err(rid, e.code, msg, 504 if e.code == "PROCESSING_TIMEOUT" else 503)
        except BaseException:
            if trial:
                db.settle_trial(user["id"], slug, rid, False, "INTERNAL_ERROR")
            raise
    if trial:
        db.settle_trial(user["id"], slug, rid, True)
    db.record_execution(rid, user["id"], slug, "success", started, None, meta_json)
    log(event="playground", request_id=rid, technology=slug, outcome="success", admin=user["admin"],
        latency_ms=int((time.time() - started) * 1000))
    return {"request_id": rid, "status": "success", "technology": slug, "data": output}


# ---------- pages ----------

@app.exception_handler(404)
async def not_found(request: Request, exc):
    if request.url.path.startswith("/api/"):
        return err(request.state.rid, "NOT_FOUND", "Not found.", 404)
    return page(request, "404.html", 404)


def page(request, name, status=200, **ctx):
    return templates.TemplateResponse(request, name, ctx, status_code=status)


@app.get("/")
def home(request: Request):
    return page(request, "home.html", featured=[t for t in registry() if t["status"] in LIVE])


@app.get("/technologies")
def catalog(request: Request, category: str = ""):
    techs = registry()
    return page(request, "catalog.html", techs=techs, category=category,
                categories=sorted({t["category"] for t in techs}))


@app.get("/technologies/{slug}")
def detail(request: Request, slug: str):
    t = get_tech(slug)
    return page(request, "detail.html", t=t) if t else page(request, "404.html", 404)


@app.get("/playground")
def playground_index():
    return RedirectResponse("/technologies")


@app.get("/playground/{slug}")
def playground(request: Request, slug: str):
    t = get_tech(slug)
    if not t or not t.get("playground_enabled"):
        return RedirectResponse(f"/technologies/{slug}" if t else "/technologies")
    return page(request, "playground.html", t=t)


@app.get("/docs")
def docs_index(request: Request):
    return page(request, "docs_index.html", techs=[t for t in registry() if t.get("docs")])


@app.get("/docs/{slug}")
def docs(request: Request, slug: str):
    t = get_tech(slug)
    if not t or not t.get("docs"):
        return page(request, "404.html", 404)
    return page(request, "docs.html", t=t, techs=[x for x in registry() if x.get("docs")],
                example=json.dumps(t["docs"]["response_example"], indent=2))


@app.get("/about")
def about(request: Request):
    return page(request, "about.html")


@app.get("/privacy")
def privacy(request: Request):
    return page(request, "privacy.html")


@app.get("/account")
def account(request: Request):
    return page(request, "account.html", techs=[t for t in registry() if t.get("playground_enabled")])
