import express from 'express'
import TelegramBot from 'node-telegram-bot-api'
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    Browsers
} from '@whiskeysockets/baileys'

const app = express()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID

// Sanity check: Fail fast if Railway env vars are missing or misconfigured
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OWNER_ID) {
    console.error("CRITICAL: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID in environment variables.")
    process.exit(1)
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })
let sock = null

function isOwner(msg) {
    return String(msg.chat.id) === String(TELEGRAM_OWNER_ID)
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: true,
        // REQUIRED: Spoof a browser so WhatsApp accepts the pairing code request
        browser: Browsers.ubuntu('Chrome') 
    })
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr && !sock.authState.creds.registered) {
            console.log('Ready for pairing via Telegram')
            // Catching promises to prevent Unhandled Rejection crashes
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is ready. Send /pair <phone number>')
               .catch(console.error)
        }
        
        if (connection === 'open') {
            console.log('✅ Habibi Connected successfully!')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is now online!')
               .catch(console.error)
        }
        
        if (connection === 'close') {
            const shouldReconnect = 
                (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut)
            
            console.log('Connection closed:', lastDisconnect?.error?.message)
            
            if (shouldReconnect) {
                console.log('Reconnecting in 5 seconds...')
                // Backoff timer prevents endless loops that exhaust Railway CPU/Filesystem
                setTimeout(connectToWhatsApp, 5000) 
            } else {
                console.log('Logged out.')
                bot.sendMessage(TELEGRAM_OWNER_ID, '❌ Habibi logged out.')
                   .catch(console.error)
            }
        }
    })
    
    sock.ev.on('creds.update', saveCreds)
}

// Telegram Commands
bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) {
        return bot.sendMessage(msg.chat.id, "❌ Owner only.").catch(console.error)
    }

    const phone = match[1].replace(/\D/g, '')
    if (!phone) {
        return bot.sendMessage(msg.chat.id, "❌ Invalid number.").catch(console.error)
    }

    try {
        if (!sock) {
            return bot.sendMessage(msg.chat.id, "❌ WhatsApp socket is initializing, wait a moment.").catch(console.error)
        }
        
        const code = await sock.requestPairingCode(phone)
        bot.sendMessage(msg.chat.id, `🔑 Pairing Code: ${code}\n\nWhatsApp > Linked Devices > Link a Device`)
           .catch(console.error)
    } catch (e) {
        console.error("Pairing code error:", e)
        bot.sendMessage(msg.chat.id, "❌ Failed to generate code. Check server logs.")
           .catch(console.error)
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, "👋 Habibi pairing ready.\nUse /pair <number>")
       .catch(console.error)
})

app.get('/', (req, res) => res.send('Habibi Running on Railway!'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    connectToWhatsApp()
})
    
