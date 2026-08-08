# Habibi Control — admin panel

A static, dependency-free control panel (no build step) for the Habibi bot.
It talks directly to the bot's `/api/*` routes on your VPS, plus `/ws` for
live activity. Deployed separately on Vercel; the bot itself stays on Oracle.

## 1. Get the VPS ready

The panel is a browser page served from `https://your-panel.vercel.app`, but
it calls your VPS directly from the visitor's browser. Two things have to be
true for that to work:

**a) Your VPS must serve HTTPS**, not plain HTTP. A browser page loaded over
HTTPS (which Vercel always uses) is blocked from calling a plain `http://`
API — this is the browser's mixed-content rule, not something in this code.
Easiest fix: put [Caddy](https://caddyserver.com/) in front of Habibi — it
gets you free auto-renewing HTTPS with about 5 lines of config:

```
# /etc/caddy/Caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```
(Needs a domain pointed at your VPS's IP. If you don't have one, a free
option is a Cloudflare Tunnel instead of Caddy — ask if you want those steps.)

**b) Open the port two layers deep** (only needed if you're hitting the VPS
directly without a domain/proxy in front):
1. Oracle Console → your instance → **Subnet** → **Security Lists** → **Add
   Ingress Rule** → allow TCP for whichever port you're exposing (443 if
   using Caddy, 3000 if not).
2. On the VM: `sudo ufw allow 443` (or `3000`), or the iptables equivalent.

## 2. Set the new env vars on the VPS

```
ADMIN_SECRET=<rotate this — it was committed in plaintext in DEPLOY-ORACLE.md>
ALLOWED_ORIGIN=https://your-panel.vercel.app
```

`ALLOWED_ORIGIN` can be a comma-separated list if you also want to hit the
API from `http://localhost:5500` or similar while testing.

Then:
```
cd ~/habibi
git pull
npm install
pm2 restart habibi
```

## 3. Deploy this folder to Vercel

1. Push this repo (with `/admin-panel`) to GitHub.
2. In Vercel → **Add New Project** → import the repo.
3. Under **Root Directory**, set it to `admin-panel`.
4. Framework preset: **Other** (it's plain HTML/CSS/JS — no build command,
   no output directory override needed).
5. Deploy.

## 4. Sign in

Open the deployed panel URL, enter:
- **Server URL** — `https://your-domain.com` (or `https://vps-ip`) — no
  trailing slash, no `/api` on the end.
- **Admin secret** — the `ADMIN_SECRET` value from the VPS `.env`.

The panel stores both in the browser's `localStorage` (not cookies, not sent
anywhere but your own VPS) so you don't have to re-enter them every visit.
Sign out clears it.

## What it can currently do

- **Overview** — live player/group/habz counts, 24h volume, leaderboard, a
  scrolling ticker of real-time activity over the websocket
- **Users** — search, view profile + inventory, adjust balance, reset steal
  cooldown, kill/revive
- **Groups** — list with member counts, send a broadcast message or airdrop
  to any group
- **Shop** — edit vehicle/house prices live (no redeploy needed)
- **Moderators** — add/remove
- **Settings** — toggle the `.ai` personality replies bot-wide, view
  connection status

Everything here maps to a route in `lib/adminApi.js` — add a route there and
a section here to extend it further.
