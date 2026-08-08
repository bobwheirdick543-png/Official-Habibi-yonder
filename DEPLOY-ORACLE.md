# Deploying Habibi to Oracle Cloud (Free Tier VM)

No dashboard auto-deploy here — this is a real server. Longer process than Railway/Render, but one-time setup. Do this in order; each phase depends on the last one working.

## Phase 1: Create the VM

1. cloud.oracle.com → sign in → hamburger menu → **Compute** → **Instances**
2. **Create Instance**
3. Name it `habibi`
4. **Image and shape** → Edit:
   - Image: **Canonical Ubuntu** (latest, e.g. 24.04) — most documented, easiest to get help with
   - Shape: try **VM.Standard.A1.Flex** (Ampere ARM) first — Always Free eligible up to 4 OCPUs / 24GB RAM, far more than the AMD option for the same $0. If it says "out of capacity," that's a known Oracle free-tier issue in busy regions — fall back to **VM.Standard.E2.1.Micro** (AMD, smaller but reliably available) or try a different region.
5. **Networking** — leave defaults (Oracle auto-creates a public IP)
6. **SSH keys** — leave "Generate a key pair for me" selected → **Save Private Key** the moment it offers. This is your only chance — download it now.
7. **Create**. Wait ~1 minute until status shows **Running**, then copy the **Public IP** shown on the instance page — you'll need it for every step below.

## Phase 2: SSH access from your phone

1. Install **Termux** — get it from F-Droid, not the Play Store (Play Store version is outdated and no longer maintained)
2. Open Termux, run:
```
pkg update && pkg upgrade -y
pkg install openssh -y
termux-setup-storage
```
Allow the storage permission prompt that pops up.

3. Find your downloaded key:
```
ls ~/storage/downloads/
```
Look for the `.key` file from step 6 above, then (replace the filename with what you actually see):
```
cp ~/storage/downloads/YOUR-KEY-FILENAME.key ~/oracle_key.key
chmod 600 ~/oracle_key.key
```

4. Connect (replace `YOUR_PUBLIC_IP`):
```
ssh -i ~/oracle_key.key ubuntu@YOUR_PUBLIC_IP
```
First connection asks to confirm the host — type `yes`.

You're now inside the server.

## Phase 3: Prepare the server

Run these one at a time:
```
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
```

Confirm it worked:
```
node --version
npm --version
```

## Phase 4: Deploy Habibi

```
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git habibi
cd habibi
npm install
```

Create your `.env` file directly on the server:
```
nano .env
```
Paste in (fill in your real values — same 6 as Railway/Render, plus one):
```
SUPABASE_URL=https://itblwdmdssuhajijbyeo.supabase.co
SUPABASE_SERVICE_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
GROQ_API_KEY=
ADMIN_SECRET=choose-a-long-random-value-here
ALLOWED_ORIGIN=https://your-panel.vercel.app
PORT=3000
```
Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

Test it runs:
```
node index.js
```
Watch for `Health check server running` and the connection attempts. `Ctrl+C` to stop once you've confirmed it's working — this was just a test run, not the real way it stays alive.

## Phase 5: Keep it running permanently

```
sudo npm install -g pm2
pm2 start index.js --name habibi
pm2 save
pm2 startup
```
`pm2 startup` prints out a command starting with `sudo env PATH=...` — copy that exact line it gives you and run it too, then:
```
pm2 save
```
Now Habibi survives reboots and restarts automatically if it ever crashes.

**Useful pm2 commands going forward:**
```
pm2 logs habibi        # live logs
pm2 restart habibi     # restart after you push code changes
pm2 stop habibi        # stop it
```

## Updating code later

No auto-deploy from GitHub here — you pull manually:
```
cd ~/habibi
git pull
npm install
pm2 restart habibi
```

## Phase 6: Firewall + HTTPS (needed now that the admin panel exists)

See `admin-panel/README.md` for the full walkthrough (Caddy for free HTTPS,
opening the port, and deploying the panel itself to Vercel). Short version:

1. Point a domain at this VM's public IP, put Caddy in front of port 3000 for
   automatic HTTPS.
2. Oracle Console → your instance → **Subnet** → **Security Lists** → **Add Ingress Rule** → allow TCP 443 (or 3000 if skipping Caddy).
3. On the VM: `sudo ufw allow 443` (or `sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT` then `sudo netfilter-persistent save`).
4. Set `ADMIN_SECRET` (rotated, not the placeholder above) and `ALLOWED_ORIGIN` in `.env`, then `pm2 restart habibi`.
