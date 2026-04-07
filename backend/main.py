from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr
from typing import Optional, List
from uuid import uuid4
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
import os
import shutil
import smtplib
import html as html_lib
import chromadb
from chromadb.utils import embedding_functions
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import httpx

# Load .env from this file's directory (works even if uvicorn is started from another folder).
load_dotenv(Path(__file__).resolve().parent / ".env")

# -----------------------------
# FastAPI app
# -----------------------------
FRONTEND_URL = os.getenv("PUBLIC_FRONTEND_URL")
API_URL = os.getenv("PUBLIC_API_URL")
app = FastAPI(title="Postcard AI API", version="0.1.0")

# Set CORS_ALLOW_ALL=true so any website (or shared links opened from anywhere) can call the API.
# Cannot use credentials with wildcard origins.
_cors_all = os.getenv("CORS_ALLOW_ALL", "").lower() in ("1", "true", "yes")
cors_allow_origins_env = os.getenv("CORS_ALLOW_ORIGINS")
if _cors_all:
    allow_origins = ["*"]
    cors_credentials = False
elif cors_allow_origins_env:
    allow_origins = [o.strip() for o in cors_allow_origins_env.split(",") if o.strip()]
    cors_credentials = True
else:
    allow_origins = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    ]
    cors_credentials = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=cors_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR_NAME = "uploads"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, UPLOAD_DIR_NAME)
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Serve uploaded photos for the generated postcard.
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# -----------------------------
# Vector DB (ChromaDB)
# -----------------------------

chroma_client = chromadb.Client()
embedding_function = embedding_functions.DefaultEmbeddingFunction()

memory_collection = chroma_client.get_or_create_collection(
    name="memories",
    embedding_function=embedding_function
)

# -----------------------------
# In-memory storage for MVP
# Replace later with Postgres
# -----------------------------

POSTCARDS = []


def _url_with_scheme_for_parse(url: str) -> str:
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        return f"https://{u}"
    return u


def is_local_or_loopback_public_url(url: str) -> bool:
    """True if this must not be used in emails or share links (localhost / loopback)."""
    if not url or not url.strip():
        return True
    try:
        p = urlparse(_url_with_scheme_for_parse(url))
        h = (p.hostname or "").lower()
    except Exception:
        return True
    if h == "localhost" or h.endswith(".localhost"):
        return True
    if h in ("127.0.0.1", "::1", "0.0.0.0"):
        return True
    if h.startswith("127."):
        return True
    return False


def public_frontend_base() -> str:
    raw = os.getenv("PUBLIC_FRONTEND_URL", "").strip().rstrip("/")
    if not raw or is_local_or_loopback_public_url(raw):
        return ""
    return raw


def public_api_base() -> str:
    """
    Public base URL for this API (postcard links + images in email).
    Order: PUBLIC_API_URL, then platform defaults (Render / Railway / Fly) so deploy works without extra env.
    """
    raw = os.getenv("PUBLIC_API_URL", "").strip().rstrip("/")
    if raw and not is_local_or_loopback_public_url(raw):
        return raw

    render_url = os.getenv("RENDER_EXTERNAL_URL", "").strip().rstrip("/")
    if render_url and not is_local_or_loopback_public_url(render_url):
        return render_url

    railway = os.getenv("RAILWAY_PUBLIC_DOMAIN", "").strip().rstrip("/")
    if railway:
        rw = f"https://{railway}"
        if not is_local_or_loopback_public_url(rw):
            return rw

    fly_app = os.getenv("FLY_APP_NAME", "").strip()
    if fly_app:
        fw = f"https://{fly_app}.fly.dev"
        if not is_local_or_loopback_public_url(fw):
            return fw

    return ""


def share_url_for_id(postcard_id: str) -> Optional[str]:
    base = public_frontend_base()
    if not base:
        return None
    return f"{base}/?share={postcard_id}"


def view_url_for_id(postcard_id: str) -> Optional[str]:
    """Public HTML page on this API (works for email recipients without the React app)."""
    api = public_api_base()
    if not api:
        return None
    return f"{api}/postcard/{postcard_id}/view"


def email_open_link(postcard_id: str) -> Optional[str]:
    """Single link for emails and UI: SPA first, else API-hosted postcard page."""
    spa = share_url_for_id(postcard_id)
    if spa:
        return spa
    return view_url_for_id(postcard_id)


def absolute_image_url(image_path: Optional[str]) -> Optional[str]:
    """For emails: full URL to uploaded image (needs PUBLIC_API_URL when not localhost)."""
    if not image_path:
        return None
    api = public_api_base()
    if not api:
        return None
    return f"{api}{image_path}"


def attach_share_url(postcard: dict) -> dict:
    out = dict(postcard)
    pid = postcard["id"]
    out["share_url"] = share_url_for_id(pid)
    out["view_url"] = view_url_for_id(pid)
    out["postcard_url"] = email_open_link(pid)
    return out


def send_postcard_email(to_email: str, postcard: dict, personal_note: Optional[str] = None) -> tuple[bool, str]:
    """
    Try Resend (RESEND_API_KEY), then SMTP (SMTP_HOST, etc.).
    Returns (ok, detail_message).
    """
    open_link = email_open_link(postcard["id"])
    msg_text = postcard["generated_message"]
    subject = f"A postcard for you — from {postcard['location']}"
    note = (personal_note or "").strip()
    plain = f"{msg_text}\n"
    if open_link:
        plain += f"\nOpen your postcard: {open_link}\n"
    else:
        plain += "\n(No web link — ask the sender to share the link from the app, or set PUBLIC_FRONTEND_URL or PUBLIC_API_URL in server .env.)\n"
    if note:
        plain += f"\n{note}\n"

    img_url = absolute_image_url(postcard.get("image_url"))
    safe_msg = html_lib.escape(msg_text)
    safe_note = html_lib.escape(note) if note else ""
    note_html = f'<p style="margin-top:16px;font-style:italic;color:#555;">{safe_note}</p>' if note else ""
    img_html = f'<p><img src="{html_lib.escape(img_url)}" alt="Postcard" style="max-width:100%;border-radius:6px"/></p>' if img_url else ""

    if open_link:
        safe_href = html_lib.escape(open_link)
        link_block = f'<p style="margin-top:20px;"><a href="{safe_href}" style="color:#8B0000;">Open your postcard</a></p>'
    else:
        link_block = (
            '<p style="margin-top:20px;color:#555;font-size:15px;line-height:1.5;">'
            "No web link was added. Ask the sender for the postcard link from their app, "
            "or they can set <code>PUBLIC_FRONTEND_URL</code> (your app URL) or "
            "<code>PUBLIC_API_URL</code> (this API’s public URL) in <code>backend/.env</code>."
            "</p>"
        )

    html_body = f"""<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#faf8f3;padding:24px;">
<p style="font-size:18px;line-height:1.5;color:#2c3e6b;">{safe_msg}</p>
{img_html}
{note_html}
{link_block}
</body></html>"""

    resend_key = os.getenv("RESEND_API_KEY", "").strip()
    if resend_key:
        from_addr = os.getenv("EMAIL_FROM", "Postcard <onboarding@resend.dev>")
        try:
            r = httpx.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {resend_key}", "Content-Type": "application/json"},
                json={
                    "from": from_addr,
                    "to": [to_email],
                    "subject": subject,
                    "html": html_body,
                    "text": plain,
                },
                timeout=30.0,
            )
            if r.status_code >= 400:
                return False, f"Resend error {r.status_code}: {r.text}"
            return True, "sent_via_resend"
        except Exception as e:
            return False, f"Resend failed: {e}"

    smtp_host = os.getenv("SMTP_HOST", "").strip()
    # Gmail app passwords are 16 chars; Google often shows them with spaces — strip all whitespace.
    smtp_password = "".join(os.getenv("SMTP_PASSWORD", "").split())
    if smtp_host and smtp_password:
        port = int(os.getenv("SMTP_PORT", "587"))
        user = os.getenv("SMTP_USER", "").strip()
        from_addr = os.getenv("SMTP_FROM", user or "postcard@localhost")
        use_ssl = os.getenv("SMTP_SSL", "").lower() in ("1", "true", "yes") or port == 465
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = from_addr
            msg["To"] = to_email
            msg.attach(MIMEText(plain, "plain"))
            msg.attach(MIMEText(html_body, "html"))
            if use_ssl:
                with smtplib.SMTP_SSL(smtp_host, port, timeout=30) as server:
                    if user:
                        server.login(user, smtp_password)
                    server.sendmail(from_addr, [to_email], msg.as_string())
            else:
                with smtplib.SMTP(smtp_host, port, timeout=30) as server:
                    server.starttls()
                    if user:
                        server.login(user, smtp_password)
                    server.sendmail(from_addr, [to_email], msg.as_string())
            return True, "sent_via_smtp"
        except Exception as e:
            return False, f"SMTP failed: {e}"

    if smtp_host and not smtp_password:
        return False, "smtp_password_missing"

    return False, "no_mailer_configured"

# -----------------------------
# Models
# -----------------------------

class HealthResponse(BaseModel):
    status: str
    timestamp: str


class PostcardResponse(BaseModel):
    id: str
    recipient: str
    location: str
    tone: str
    memory: str
    theme: str
    image_url: Optional[str]
    generated_message: str
    created_at: str
    share_url: Optional[str] = None
    view_url: Optional[str] = None
    postcard_url: Optional[str] = None


class SendPostcardRequest(BaseModel):
    postcard_id: str
    recipient_email: EmailStr
    personal_note: Optional[str] = None


class MemoryItem(BaseModel):
    id: str
    text: str
    created_at: str

# -----------------------------
# Health check
# -----------------------------

@app.get("/health", response_model=HealthResponse)
def health_check():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat()
    }

# -----------------------------
# Generate postcard
# -----------------------------

@app.post("/api/postcards/generate", response_model=PostcardResponse)
async def generate_postcard(
    recipient: str = Form(...),
    location: str = Form(...),
    tone: str = Form(...),
    memory: str = Form(...),
    theme: str = Form(...),
    photo: UploadFile = File(...),
):

    allowed_types = {"image/jpeg", "image/png", "image/webp"}

    if photo.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported image format")

    postcard_id = str(uuid4())

    extension = os.path.splitext(photo.filename or "")[1] or ".jpg"

    filename = f"{postcard_id}{extension}"

    image_path = os.path.join(UPLOAD_DIR, filename)

    with open(image_path, "wb") as buffer:
        shutil.copyfileobj(photo.file, buffer)

    generated_message = build_postcard_message(recipient, location, tone, memory)

    postcard = {
        "id": postcard_id,
        "recipient": recipient,
        "location": location,
        "tone": tone,
        "memory": memory,
        "theme": theme,
        "image_url": f"/{UPLOAD_DIR_NAME}/{filename}",
        "generated_message": generated_message,
        "created_at": datetime.utcnow().isoformat(),
    }

    POSTCARDS.append(postcard)

    try:
        memory_collection.add(
            documents=[memory],
            ids=[postcard_id],
            metadatas=[{"recipient": recipient, "location": location}],
        )
    except Exception:
        # Generation should still succeed if Chroma/embeddings fail locally.
        pass

    return attach_share_url(postcard)


@app.post("/create-postcard")
def create_postcard():
    postcard_id = str(uuid4())
    link = f"{FRONTEND_URL}/postcard/{postcard_id}"

    return {"id": postcard_id, "link": link}

# -----------------------------
# List postcards
# -----------------------------

@app.get("/api/postcards", response_model=List[PostcardResponse])
def list_postcards():
    return [attach_share_url(p) for p in reversed(POSTCARDS)]

# -----------------------------
# Get postcard
# -----------------------------

@app.get("/api/postcards/{postcard_id}", response_model=PostcardResponse)
def get_postcard(postcard_id: str):

    for postcard in POSTCARDS:
        if postcard["id"] == postcard_id:
            return attach_share_url(postcard)

    raise HTTPException(status_code=404, detail="Postcard not found")


@app.get("/postcard/{postcard_id}/view", response_class=HTMLResponse)
def postcard_public_html_view(postcard_id: str):
    """Simple page so email can link here when PUBLIC_FRONTEND_URL is not set (same host as API)."""
    for postcard in POSTCARDS:
        if postcard["id"] != postcard_id:
            continue
        msg = html_lib.escape(postcard["generated_message"])
        rec = html_lib.escape(postcard["recipient"])
        loc = html_lib.escape(postcard["location"])
        rel_img = postcard.get("image_url") or ""
        img_tag = (
            f'<p><img src="{html_lib.escape(rel_img)}" alt="Postcard" style="max-width:min(520px,100%);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.12)"/></p>'
            if rel_img
            else ""
        )
        page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Postcard for {rec}</title></head>
<body style="margin:0;font-family:Georgia,serif;background:#6b1414;background-image:repeating-linear-gradient(90deg,transparent,transparent 18px,rgba(255,255,255,0.06) 18px,rgba(255,255,255,0.06) 36px);min-height:100vh;padding:32px 16px;">
<div style="max-width:560px;margin:0 auto;background:#fffef5;border:1px solid #e8d5a3;border-radius:10px;padding:28px;box-shadow:0 12px 40px rgba(0,0,0,0.2);">
<p style="color:#8B0000;font-size:14px;letter-spacing:2px;text-transform:uppercase;margin:0 0 8px;">Postcard</p>
<h1 style="color:#2c3e6b;font-size:22px;margin:0 0 16px;">For {rec}</h1>
{img_tag}
<p style="color:#2c3e6b;font-size:18px;line-height:1.55;margin:16px 0 0;">{msg}</p>
<p style="color:#6b1a2a;font-size:14px;margin-top:20px;font-style:italic;">{loc}</p>
</div></body></html>"""
        return HTMLResponse(content=page)

    raise HTTPException(status_code=404, detail="Postcard not found")


# -----------------------------
# Search memories (Vector search)
# -----------------------------

@app.get("/api/memories/search")
def search_memories(query: str):

    results = memory_collection.query(
        query_texts=[query],
        n_results=5
    )

    return results

# -----------------------------
# Send postcard (email placeholder)
# -----------------------------

@app.post("/api/postcards/send")
def send_postcard(payload: SendPostcardRequest):

    postcard = next((p for p in POSTCARDS if p["id"] == payload.postcard_id), None)

    if not postcard:
        raise HTTPException(status_code=404, detail="Postcard not found")

    ok, detail = send_postcard_email(
        str(payload.recipient_email),
        postcard,
        personal_note=payload.personal_note,
    )
    if not ok:
        if detail == "smtp_password_missing":
            raise HTTPException(
                status_code=503,
                detail=(
                    "SMTP is set but SMTP_PASSWORD is empty. Add your Gmail App Password to "
                    "postcard/backend/.env (Google Account → Security → App passwords), then restart uvicorn."
                ),
            )
        if detail == "no_mailer_configured":
            raise HTTPException(
                status_code=503,
                detail=(
                    "Email is not configured. In postcard/backend/.env set either: "
                    "(1) RESEND_API_KEY and EMAIL_FROM, or "
                    "(2) SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM. "
                    "See postcard/backend/.env."
                ),
            )
        raise HTTPException(status_code=502, detail=detail)

    return {
        "status": "sent",
        "detail": detail,
        "to": payload.recipient_email,
        "postcard_id": payload.postcard_id,
        "postcard_url": email_open_link(postcard["id"]),
        "share_url": share_url_for_id(postcard["id"]),
        "view_url": view_url_for_id(postcard["id"]),
    }

# -----------------------------
# Root route
# -----------------------------

@app.get("/")
def root():
    return {
        "message": "Postcard AI backend running"
    }

# -----------------------------
# Simple AI message generator
# Later replace with OpenAI
# -----------------------------

def build_postcard_message(recipient, location, tone, memory):

    tone = tone.lower().strip()

    if tone == "romantic":
        return f"Greetings from {location}. Every moment here reminds me of you. {memory}."

    if tone == "nostalgic":
        return f"Greetings from {location}. This place brings back memories that feel warm and familiar. {memory}."

    if tone == "funny":
        return f"Greetings from {location}. I came for the views but stayed for the chaos. {memory}."

    return f"Greetings from {location}. I wanted to send you a little moment from here. {memory}."

# -----------------------------
# Run server
# -----------------------------

# uvicorn main:app --reload --port 8000
