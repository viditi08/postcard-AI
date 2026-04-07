# Deploy so email recipients get a real postcard link

Your API must be on the **public internet** (HTTPS). Localhost links cannot work for other people.

## Option A — Render (free tier)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Blueprint**.
3. Connect the repo. If the repo root is only `postcard/`, point the blueprint at `render.yaml` inside it.
4. Deploy. Render gives you a URL like `https://postcard-api-xxxx.onrender.com`.
5. The app reads **`RENDER_EXTERNAL_URL`** automatically, so **`postcard_url`** and emails get the correct link without setting `PUBLIC_API_URL`.
6. In the Render dashboard → **Environment**, add your **SMTP** variables (or Resend) so “Send to their email” works.

## Option B — Docker anywhere

From the `backend` folder:

```bash
docker build -t postcard-api .
docker run -p 8000:8000 -e CORS_ALLOW_ALL=true postcard-api
```

For a public URL, run the container on a host that gives you HTTPS and set `PUBLIC_API_URL` to that URL if the platform does not set `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` / `FLY_APP_NAME`.

## Frontend (optional)

Host the Vite app on **Vercel**, **Netlify**, or **Render Static Site**.  
Build command: `cd frontend && npm ci && npm run build`  
Publish directory: `frontend/dist`  

Set build env **`VITE_API_BASE_URL`** to your **deployed API URL** (same as `PUBLIC_API_URL`).

Then set on the API **`PUBLIC_FRONTEND_URL`** to your deployed frontend URL so links prefer `?share=`.

## Notes

- Free dynos may sleep; first request can be slow.
- Uploaded images and in-memory postcards reset when the service restarts unless you add a database and object storage later.
