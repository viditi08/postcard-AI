import React, { useState, useEffect, useCallback } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

function hostnameIsLocal(host) {
  if (!host) return true;
  const h = String(host).toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
}

function shareUrlForPostcard(pc) {
  const tryUrl = (u) => {
    if (!u) return null;
    try {
      const h = new URL(u).hostname;
      if (!hostnameIsLocal(h)) return u;
    } catch {
      /* ignore */
    }
    return null;
  };
  return (
    tryUrl(pc?.postcard_url) ||
    tryUrl(pc?.view_url) ||
    tryUrl(pc?.share_url) ||
    (() => {
      if (!pc?.id) return "";
      if (hostnameIsLocal(window.location.hostname)) return "";
      const base = `${window.location.origin}${window.location.pathname}`;
      const u = new URL(base);
      u.searchParams.set("share", pc.id);
      return u.toString();
    })()
  );
}

export default function PostcardSite() {
  const [view, setView] = useState("landing");
  const [sharedLoading, setSharedLoading] = useState(false);
  const [sharedError, setSharedError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sendStatus, setSendStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [postcard, setPostcard] = useState(null);
  const [formData, setFormData] = useState({
    recipientName: "",
    recipientEmail: "",
    location: "",
    tone: "classic",
    memory: "",
    style: "classic",
  });
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState(null);

  const loadShared = useCallback(async (id) => {
    setSharedLoading(true);
    setSharedError("");
    try {
      const res = await fetch(`${API_BASE_URL}/api/postcards/${id}`);
      if (!res.ok) throw new Error("This postcard link is missing or expired.");
      const json = await res.json();
      setPostcard(json);
      setView("shared");
    } catch (e) {
      setPostcard(null);
      setSharedError(e?.message || "Could not load postcard.");
      setView("shared");
    } finally {
      setSharedLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("share");
    if (id) loadShared(id);
  }, [loadShared]);

  const goCompose = () => {
    setError("");
    setSendStatus("");
    setCopied(false);
    setView("compose");
  };

  const goLanding = () => {
    window.history.replaceState({}, "", window.location.pathname);
    setPostcard(null);
    setView("landing");
  };

  const handlePhotoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setPhoto(file);
      setPreview(URL.createObjectURL(file));
    }
  };

  const stylePreview = () => {
    switch (formData.style) {
      case "vintage":
        return { filter: "sepia(0.65) contrast(0.9) brightness(0.95) saturate(0.75)" };
      case "sepia-memory":
        return { filter: "sepia(0.9) contrast(0.92) brightness(0.94) saturate(0.7)" };
      case "soft-film":
        return { filter: "contrast(0.88) brightness(1.02) saturate(0.82)" };
      case "warm-paper":
        return { filter: "sepia(0.35) brightness(1) contrast(0.9) saturate(0.85)" };
      case "monochrome-ink":
        return { filter: "grayscale(1) contrast(1.08) brightness(0.96)" };
      default:
        return { filter: "none" };
    }
  };

  const handleGenerate = async () => {
    setError("");
    setSendStatus("");
    if (!formData.recipientName || !formData.location || !formData.memory || !photo) {
      setError("Add their name, a place, a memory, and a photo.");
      return;
    }
    if (!formData.recipientEmail.trim()) {
      setError("Add their email so you can send the postcard.");
      return;
    }

    setLoading(true);
    try {
      const body = new FormData();
      body.append("recipient", formData.recipientName);
      body.append("location", formData.location);
      body.append("tone", formData.tone || "classic");
      body.append("memory", formData.memory);
      body.append("theme", formData.style);
      body.append("photo", photo);

      const res = await fetch(`${API_BASE_URL}/api/postcards/generate`, {
        method: "POST",
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Could not create postcard (${res.status})`);
      }

      const json = await res.json();
      setPostcard(json);
      setView("result");
    } catch (e) {
      setPostcard(null);
      setError(e?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!postcard?.id) return;
    const url = publicShareLink;
    if (!url) {
      setSendStatus(
        "No public link to copy. In backend .env set PUBLIC_FRONTEND_URL or PUBLIC_API_URL to your deployed HTTPS URLs (localhost is not used in links).",
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleSendEmail = async () => {
    if (!postcard?.id || !formData.recipientEmail.trim()) return;
    setSendStatus("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/postcards/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postcard_id: postcard.id,
          recipient_email: formData.recipientEmail.trim(),
        }),
      });
      const text = await res.text().catch(() => "");
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const detail = json?.detail;
        const msg =
          typeof detail === "string"
            ? detail
            : Array.isArray(detail)
              ? detail.map((d) => d.msg || d).join(" ")
              : text || `Send failed (${res.status})`;
        throw new Error(msg);
      }
      setSendStatus(
        json?.status === "sent"
          ? `Email sent. ${json?.postcard_url ? `Link in email: ${json.postcard_url}` : "Set PUBLIC_API_URL so the email includes an open link."} Check spam if needed.`
          : json?.message || "Done.",
      );
    } catch (e) {
      setSendStatus(e?.message || "Could not queue send.");
    } finally {
      setLoading(false);
    }
  };

  const greeting = (() => {
    if (!postcard?.generated_message) return "Greetings from afar.";
    const first = String(postcard.generated_message).split(".")[0].trim();
    return first ? `${first}.` : "Greetings from afar.";
  })();

  const publicShareLink = postcard ? shareUrlForPostcard(postcard) : "";

  return (
    <div
      style={{
        fontFamily: "'Georgia', serif",
        minHeight: "100vh",
        backgroundImage: "url('/images/redstripe.jpg')",
        backgroundSize: "auto",
        backgroundRepeat: "repeat",
        backgroundPosition: "top left",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=Playfair+Display:ital,wght@0,400;0,700&family=Courier+Prime&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .nav {
          background: #f5f0e6;
          border-bottom: 2px solid #b8c8d8;
          padding: 12px 28px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
          border: none;
          background: none;
        }
        .brand-title {
          font-family: 'Caveat', cursive;
          font-size: 1.85rem;
          font-weight: 700;
          color: #8B0000;
        }
        .nav-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .nav-btn {
          font-family: 'Playfair Display', serif;
          font-size: 0.95rem;
          color: #2c3e6b;
          background: none;
          border: none;
          padding: 8px 14px;
          cursor: pointer;
        }
        .nav-btn:hover { color: #8B0000; }
        .hero {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 28px 18px 48px;
          gap: 20px;
        }
        .frame {
          width: min(520px, 92vw);
          border-radius: 2px;
          border: 1.5px solid rgba(185, 200, 216, 0.65);
          box-shadow: 0 12px 36px rgba(0,0,0,0.1);
        }
        .hero-title {
          font-family: 'Playfair Display', serif;
          font-size: clamp(32px, 5.2vw, 52px);
          font-weight: 700;
          color: rgba(255,255,255,0.92);
          text-align: center;
          text-shadow: 0 2px 0 rgba(0,0,0,0.2);
          max-width: 900px;
          line-height: 1.15;
        }
        .hero-sub {
          font-family: 'Caveat', cursive;
          font-size: clamp(1.35rem, 3vw, 1.85rem);
          color: rgba(255,255,255,0.88);
          text-align: center;
        }
        .cta {
          background: #fffef0;
          border: 2px solid #c97586;
          color: #6b1a2a;
          font-family: 'Playfair Display', serif;
          font-size: 0.95rem;
          letter-spacing: 1.4px;
          padding: 14px 44px;
          cursor: pointer;
        }
        .cta:hover { background: rgba(255,254,240,0.92); }
        .panel {
          width: min(640px, 94vw);
          margin: 0 auto 40px;
          background: rgba(255, 254, 240, 0.94);
          border: 1.5px solid #e8d5a3;
          border-radius: 8px;
          padding: 24px;
          box-shadow: 6px 6px 0 rgba(139,0,0,0.07);
        }
        .panel h2 {
          font-family: 'Playfair Display', serif;
          color: #2c3e6b;
          font-size: 1.35rem;
          margin-bottom: 16px;
        }
        .field { margin-bottom: 14px; }
        .field label {
          display: block;
          font-family: 'Playfair Display', serif;
          font-size: 0.85rem;
          color: #6b1a2a;
          margin-bottom: 6px;
        }
        .input, .textarea, .select {
          width: 100%;
          border: 1.5px solid #c0a882;
          background: #fffef8;
          border-radius: 4px;
          padding: 10px 12px;
          font-family: 'Courier Prime', monospace;
          font-size: 0.9rem;
        }
        .textarea { min-height: 100px; resize: vertical; }
        .row-btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
        .btn-primary {
          background: #f9c0cb;
          border: 1.5px solid #c97586;
          color: #6b1a2a;
          font-family: 'Playfair Display', serif;
          padding: 12px 22px;
          cursor: pointer;
          font-size: 0.9rem;
        }
        .btn-secondary {
          background: #fffef0;
          border: 1.5px solid #c0a882;
          color: #6b1a2a;
          font-family: 'Playfair Display', serif;
          padding: 12px 22px;
          cursor: pointer;
          font-size: 0.9rem;
        }
        .card-preview {
          margin-top: 20px;
          padding: 18px;
          background: #fff;
          border: 1px solid #e8d5a3;
          border-radius: 6px;
        }
        .card-msg {
          font-family: 'Playfair Display', serif;
          font-size: 1.05rem;
          line-height: 1.55;
          color: #2c3e6b;
          margin-bottom: 14px;
        }
        .card-meta {
          font-family: 'Courier Prime', monospace;
          font-size: 0.8rem;
          color: #6b1a2a;
          margin-bottom: 12px;
        }
        .err { color: #b00020; font-family: 'Courier Prime', monospace; font-size: 0.85rem; margin-top: 8px; }
        .ok { color: #1a5f1a; font-family: 'Courier Prime', monospace; font-size: 0.85rem; margin-top: 8px; }
      `}</style>

      <nav className="nav">
        <button type="button" className="brand" onClick={goLanding}>
          <img src="/images/postcard.jpg" alt="" style={{ width: 64, height: 42, objectFit: "cover" }} />
          <span className="brand-title">Postcard</span>
        </button>
        <div className="nav-actions">
          <button type="button" className="nav-btn" onClick={goLanding}>
            Home
          </button>
          <button type="button" className="nav-btn" onClick={goCompose}>
            Send a card
          </button>
          <button type="button" className="nav-btn" onClick={() => setView("about")}>
            About
          </button>
        </div>
      </nav>

      {view === "shared" && (
        <div className="hero" style={{ paddingTop: 20 }}>
          {sharedLoading && <p className="hero-sub">Opening your postcard…</p>}
          {sharedError && <p className="err">{sharedError}</p>}
          {!sharedLoading && postcard && (
            <>
              <img className="frame" src="/images/postcard.jpg" alt="" />
              <h1 className="hero-title">{greeting}</h1>
              <p className="hero-sub">For {postcard.recipient}</p>
              <div className="panel">
                <div className="card-preview">
                  {postcard.image_url ? (
                    <img
                      src={`${API_BASE_URL}${postcard.image_url}`}
                      alt=""
                      style={{ width: "100%", maxHeight: 280, objectFit: "cover", borderRadius: 4 }}
                    />
                  ) : null}
                  <p className="card-msg" style={{ marginTop: 14 }}>
                    {postcard.generated_message}
                  </p>
                  <p className="card-meta">{postcard.location}</p>
                </div>
                <div className="row-btns" style={{ marginTop: 16 }}>
                  <button type="button" className="btn-secondary" onClick={goCompose}>
                    Send your own
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {view === "landing" && (
        <div className="hero">
          <img className="frame" src="/images/postcard.jpg" alt="" />
          <h1 className="hero-title">Greetings from afar</h1>
          <p className="hero-sub">Sending warmth, one card at a time.</p>
          <button type="button" className="cta" onClick={goCompose}>
            WRITE A POSTCARD
          </button>
          {error ? <p className="err">{error}</p> : null}
        </div>
      )}

      {view === "about" && (
        <div className="panel" style={{ marginTop: 24 }}>
          <h2>About</h2>
          <p style={{ fontFamily: "'Courier Prime', monospace", lineHeight: 1.6, color: "#333" }}>
            Share links only work for other people if your site and API are on the public internet (not only
            localhost). Set backend <code>PUBLIC_FRONTEND_URL</code> and <code>PUBLIC_API_URL</code>, enable{" "}
            <code>CORS_ALLOW_ALL=true</code>, and configure <code>RESEND_API_KEY</code> (or SMTP) in{" "}
            <code>backend/.env</code>. See <code>backend/env.example</code>. The frontend build should set{" "}
            <code>VITE_API_BASE_URL</code> to your public API URL.
          </p>
          <div className="row-btns" style={{ marginTop: 16 }}>
            <button type="button" className="btn-primary" onClick={goCompose}>
              Send a card
            </button>
            <button type="button" className="btn-secondary" onClick={goLanding}>
              Home
            </button>
          </div>
        </div>
      )}

      {view === "compose" && (
        <div className="panel" style={{ marginTop: 20 }}>
          <h2>Your postcard</h2>
          {error ? <p className="err">{error}</p> : null}

          <div className="field">
            <label htmlFor="name">Their name</label>
            <input
              id="name"
              className="input"
              value={formData.recipientName}
              onChange={(e) => setFormData({ ...formData, recipientName: e.target.value })}
              placeholder="Alex"
            />
          </div>

          <div className="field">
            <label htmlFor="email">Their email</label>
            <input
              id="email"
              className="input"
              type="email"
              value={formData.recipientEmail}
              onChange={(e) => setFormData({ ...formData, recipientEmail: e.target.value })}
              placeholder="alex@example.com"
            />
          </div>

          <div className="field">
            <label htmlFor="loc">Place</label>
            <input
              id="loc"
              className="input"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              placeholder="Kyoto"
            />
          </div>

          <div className="field">
            <label htmlFor="tone">Tone</label>
            <select
              id="tone"
              className="select"
              value={formData.tone}
              onChange={(e) => setFormData({ ...formData, tone: e.target.value })}
            >
              <option value="classic">Classic</option>
              <option value="romantic">Romantic</option>
              <option value="nostalgic">Nostalgic</option>
              <option value="funny">Funny</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="mem">Memory</label>
            <textarea
              id="mem"
              className="textarea"
              value={formData.memory}
              onChange={(e) => setFormData({ ...formData, memory: e.target.value })}
              placeholder="A line they’ll want to keep…"
            />
          </div>

          <div className="field">
            <label htmlFor="style">Photo look</label>
            <select
              id="style"
              className="select"
              value={formData.style}
              onChange={(e) => setFormData({ ...formData, style: e.target.value })}
            >
              <option value="classic">Classic</option>
              <option value="vintage">Vintage</option>
              <option value="sepia-memory">Sepia</option>
              <option value="soft-film">Soft film</option>
              <option value="warm-paper">Warm paper</option>
              <option value="monochrome-ink">Ink</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="ph">Photo</label>
            <input id="ph" className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handlePhotoUpload} />
            {preview ? (
              <img
                src={preview}
                alt=""
                style={{ width: "100%", maxHeight: 220, objectFit: "cover", marginTop: 10, borderRadius: 4, ...stylePreview() }}
              />
            ) : null}
          </div>

          <div className="row-btns">
            <button type="button" className="btn-primary" disabled={loading} onClick={handleGenerate}>
              {loading ? "Creating…" : "Create postcard"}
            </button>
            <button type="button" className="btn-secondary" onClick={goLanding}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {view === "result" && postcard && (
        <div className="hero" style={{ paddingTop: 16 }}>
          <img className="frame" src="/images/postcard.jpg" alt="" />
          <h1 className="hero-title">{greeting}</h1>
          <p className="hero-sub">For {postcard.recipient}</p>

          <div className="panel">
            <div className="card-preview">
              {postcard.image_url ? (
                <img
                  src={`${API_BASE_URL}${postcard.image_url}`}
                  alt=""
                  style={{ width: "100%", maxHeight: 280, objectFit: "cover", borderRadius: 4 }}
                />
              ) : null}
              <p className="card-msg" style={{ marginTop: 14 }}>
                {postcard.generated_message}
              </p>
              <p className="card-meta">{postcard.location}</p>
            </div>

            {publicShareLink ? (
              <>
                <p style={{ fontFamily: "'Courier Prime', monospace", fontSize: "0.8rem", color: "#555", marginTop: 14 }}>
                  Link for the recipient (same as in the email — opens the postcard in the browser):
                </p>
                <p
                  style={{
                    fontFamily: "'Courier Prime', monospace",
                    fontSize: "0.75rem",
                    wordBreak: "break-all",
                    background: "#fff",
                    padding: "10px",
                    border: "1px solid #e8d5a3",
                    borderRadius: 4,
                    marginTop: 6,
                  }}
                >
                  {publicShareLink}
                </p>
              </>
            ) : (
              <p className="err" style={{ marginTop: 14 }}>
                No public postcard link yet. Deploy your API and set <code>PUBLIC_API_URL</code> in{" "}
                <code>backend/.env</code> to your live API (HTTPS, not localhost). Recipients will open{" "}
                <code>…/postcard/&lt;id&gt;/view</code>. Optionally set <code>PUBLIC_FRONTEND_URL</code> to use your
                React app with <code>?share=</code> instead.
              </p>
            )}

            <div className="row-btns" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn-primary"
                onClick={handleCopyLink}
                disabled={!publicShareLink}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
              <button type="button" className="btn-secondary" disabled={loading} onClick={handleSendEmail}>
                Send to their email
              </button>
            </div>
            {sendStatus ? <p className="ok">{sendStatus}</p> : null}

            <div className="row-btns" style={{ marginTop: 20 }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setPostcard(null);
                  setPhoto(null);
                  setPreview(null);
                  setFormData({
                    recipientName: "",
                    recipientEmail: "",
                    location: "",
                    tone: "classic",
                    memory: "",
                    style: "classic",
                  });
                  setSendStatus("");
                  setError("");
                  goCompose();
                }}
              >
                New postcard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
