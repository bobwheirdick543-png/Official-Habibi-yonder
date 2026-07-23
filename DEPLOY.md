# Deploying Habibi

## 1. Prerequisites

All free tier:

- [Railway](https://railway.app) — hosting
- [Supabase](https://supabase.com) — database (already set up: project `Habibi Official`)
- [Groq](https://console.groq.com) — AI personality
- Telegram — pairing control

## 2. Get your keys

**Supabase**
1. Open the `Habibi Official` project → Settings → API
2. Copy the **Project URL**: `https://itblwdmdssuhajijbyeo.supabase.co`
3. Copy the **service_role** key (marked "secret" — NOT the anon/publishable key)

**Groq**
1. console.groq.com → API Keys → create a new key → copy it

**Telegram**
1. Message **@BotFather** → `/newbot` → follow the prompts → copy the token it gives you
2. Message **@userinfobot** → it replies with your numeric ID instantly

## 3. Push to GitHub

Push the full repo (see README.md for the exact file layout) to a GitHub repository.

## 4. Deploy to Railway

1. Railway dashboard → New Project → Deploy from GitHub repo
2. Select your Habibi repo
3. Railway auto-detects `package.json` and `Procfile` — no build config needed

## 5. Set environment variables

Railway → your service → Variables:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://itblwdmdssuhajijbyeo.supabase.co` |
| `SUPABASE_SERVICE_KEY` | your service_role key from step 2 |
| `TELEGRAM_BOT_TOKEN` | your bot token from step 2 |
| `TELEGRAM_OWNER_ID` | your Telegram ID from step 2 |
| `GROQ_API_KEY` | your Groq key from step 2 |
| `ADMIN_SECRET` | any password you choose — not used yet, will be needed once the admin panel is built |

Don't add `PORT` — Railway sets that automatically.

## 6. Confirm it's running

Railway → Deploy Logs, look for:
```
Health check server running
```

## 7. Pair Habibi

1. Open Telegram, find the bot you made with BotFather
2. Send `/start`
3. Wait for Habibi to message you: "Habibi is ready to pair..."
4. Reply `/pair <your WhatsApp number, country code, no +>`
5. Copy the code she sends back
6. On WhatsApp: Linked Devices → Link a Device → enter the code

## 8. Add her to a group

1. Add the paired number to your WhatsApp group
2. Make her an admin
3. She's live — try `.top`, or tag her by name to chat

## Known limits right now

- Airdrops won't fire on schedule yet — the cron scheduler isn't built
- No admin panel yet — balances and broadcasts are database-only until that's done
- Max 5 groups on one number (this is a WhatsApp device-linking limit, not something the code enforces)

## Redeploying

Every `git push` triggers a new Railway deploy. Session data lives in Supabase, not on Railway's disk, so a normal code push will not log Habibi out or require re-pairing. Re-pairing is only needed if she's actually logged out from WhatsApp's side.
