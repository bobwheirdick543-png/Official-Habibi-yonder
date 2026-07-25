# Deploying Habibi to Render

Same repo, same code — nothing in `index.js` or `lib/` needed to change. This is specifically for testing whether Railway's IP range was the reason WhatsApp kept rejecting the connection.

## Read this before treating Render as the permanent home

Render's **free tier sleeps after 15 minutes with no incoming HTTP traffic.** Habibi needs a continuous connection to WhatsApp — every sleep cycle kills that connection and forces a full reconnect. For a bot that needs to stay online, this is a real problem, not a minor inconvenience.

**Use this deploy to answer one specific question:** does the same code connect successfully from Render's IP range? Watch the logs for a few minutes after deploying.

- **If it connects** — the problem was Railway's IP specifically. That's useful: it means either Render's paid tier (no sleep) or a proxy in front of Railway would fix this permanently.
- **If it still fails the same way** — it's not IP-related. It's the broader WhatsApp-side issue, and no hosting change fixes it.

Either answer is progress. Neither means "move here for good" without addressing the sleep problem separately.

## Before you deploy this — stop Railway first

Same Telegram bot token, same WhatsApp number. Running both Railway and Render at once recreates the exact duplicate-instance conflict from before — Telegram's 409 error, WhatsApp fighting over one session. Pause or remove the Railway deployment before starting this one.

## 1. Push render.yaml

Already in this repo root — Render reads it automatically, no manual dashboard config needed for build/start commands.

## 2. Create the service

1. dashboard.render.com → **New** → **Web Service**
2. Connect your GitHub repo
3. Render detects `render.yaml` — confirm the service name it shows and continue

## 3. Set environment variables

Same 6 as Railway. Render dashboard → your service → **Environment**:

```
SUPABASE_URL=https://itblwdmdssuhajijbyeo.supabase.co
SUPABASE_SERVICE_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
GROQ_API_KEY=
ADMIN_SECRET=Habibi*2026
```

## 4. Watch the logs

Render dashboard → your service → **Logs**. Same lines to look for as Railway: `Health check server running`, then the WhatsApp connection attempts. With the circuit breaker in place, it'll try up to 10 times and then stop on its own either way.

## 5. Pairing works the same way

Telegram `/pair <number>` once it says it's ready — identical flow to Railway, nothing about pairing itself changes between hosts.
