# Habibi 🦩

A WhatsApp group bot with a full in-chat economy — Habz currency, stealing, marriage, gambling, leveling, and a sassy AI personality. Built to keep groups active, not to moderate them.

## Features

- **AI personality** — replies when tagged, replied to, or called by name (Habibi, Habs, Bibi), powered by Groq
- **Text-based economy** — every 300 messages sent earns ₻2,000 Habz
- **Leveling system** — 7 tiers from Lurker to God Level, ₻100,000 per level climbed
- **Airdrops** — scheduled drops, first to `.claim` wins ₻10,000
- **Stealing** — 30% success chance, rate-limited, immunity purchasable
- **Marriage system** — propose, accept, shared vault, divorce
- **Gambling** — `.coinflip`
- **Global top 20 leaderboard**
- **Auto-welcomes new members**
- **Group-only** — ignores DMs entirely
- **Multi-group** — up to 5 groups on one number, one global wallet per user

## Commands

| Command | Description |
|---|---|
| `.top` | Global top 20 leaderboard |
| `.profile` | Your balance, level, rank, steal record |
| `.claim` | Claim an active airdrop |
| `.steal` (reply) | Attempt to steal from the replied user — 30% success |
| `.give <amount>` (reply) | Send Habz to the replied user (5% fee comes out of the transfer) |
| `.buy immunity <hours>` | ₻10,000/hour of steal immunity, stacks with existing immunity |
| `.marry` (reply) | Propose marriage |
| `.accept` | Accept a pending marriage proposal |
| `.divorce` | End your marriage, vault splits 50/50 |
| `.vault` | Check your marriage vault balance |
| `.deposit <amount>` | Add Habz to your marriage vault |
| `.coinflip <amount>` | 50/50 wager, double or nothing |

## Tech stack

- **Runtime:** Node.js, [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web API)
- **Database:** Supabase (PostgreSQL)
- **AI:** Groq
- **Pairing:** Telegram bot, owner-only
- **Hosting:** Railway
- **Admin panel:** Vercel *(not built yet)*

## Project structure

```
habibi-whatsapp/
├── index.js              entry point — WhatsApp connection, Telegram pairing, event wiring
├── package.json
├── Procfile
├── .gitignore
├── .env.example
└── lib/
    ├── economy.js         wallet, steal, give, claim, marriage, immunity, coinflip, levels
    ├── commands.js         maps .commands to economy functions, formats replies
    ├── ai.js                Groq personality + antijailbreak, per-user chat history
    ├── messageHandler.js    routes incoming messages: text counting, commands, AI triggers
    └── supabaseAuthState.js Baileys auth state backed by Supabase (survives redeploys)
```

## Setup

See [DEPLOY.md](./DEPLOY.md) for the full step-by-step deployment guide.

## Status

Core bot is live: full economy, all commands, AI personality, welcome messages, group-only enforcement.

Still pending: the cron scheduler (timed airdrops, midnight steal-reset, Saturday leaderboard reset + Sunday recap), the WebSocket + admin API backend, and the Vercel admin panel frontend.

## Credits

Built by Stain.
