import express from 'express'
import TelegramBot from 'node-telegram-bot-api'
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys'
import { useMultiFileAuthState } from '@whiskeysockets/baileys'
import { fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const app = express()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || "YOUR_TELEGRAM_ID_HERE"

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })

// Active sessions map
const activeSessions = new Map()

function sanitizePhoneNumber(phone) {
    return phone.replace(/\D/g, '')
}

function isOwner(msg) {
    return String(msg.chat.id) === String(TELEGRAM_OWNER_ID)
}

function notifyOwner(text) {
    if (TELEGRAM_OWNER_ID) {
        bot.sendMessage(TELEGRAM_OWNER_ID, text).catch(() => {})
    }
}

// ====================== CORE PAIRING FUNCTION ======================
async function startWhatsAppBot(phoneNumber, telegramChatId = null, retryCount = 0) {
    const sessionPath = path.join(__dirname, 'sessions', `session_${phoneNumber}`)
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true })
    }

    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

    const conn = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: state.keys,
        },
        markOnlineOnConnect: true,
        syncFullHistory: false,
    })

    activeSessions.set(phoneNumber, conn)

    conn.ev.on('creds.update', saveCreds)

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'open') {
            console.log(`✅ Habibi connected: ${phoneNumber}`)
            notifyOwner(`✅ *Habibi Connected*\nNumber: ${phoneNumber}`)
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            if (statusCode !== DisconnectReason.loggedOut && retryCount < 5) {
                console.log(`Reconnecting ${phoneNumber}...`)
                setTimeout(() => startWhatsAppBot(phoneNumber, telegramChatId, retryCount + 1), 5000)
            } else {
                console.log(`❌ Logged out: ${phoneNumber}`)
                notifyOwner(`❌ Habibi logged out: ${phoneNumber}`)
            }
        }
    })

    // Request Pairing Code
    if (!conn.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await conn.requestPairingCode(phoneNumber, 'HABIBIWA')
                code = code || 'HABIBIWA'

                console.log(`Pairing code for ${phoneNumber}: ${code}`)
                notifyOwner(`🔑 *Pairing Code*\nNumber: \( {phoneNumber}\nCode: <b> \){code}</b>`, { parse_mode: 'HTML' })

                bot.sendMessage(telegramChatId || TELEGRAM_OWNER_ID, 
                    `Pairing Code for \( {phoneNumber}:\n\n<b> \){code}</b>\n\nUse in WhatsApp > Linked Devices > Link with phone number.`, 
                    { parse_mode: 'HTML' }
                )
            } catch (e) {
                console.error('Pairing failed:', e)
                notifyOwner(`❌ Failed to generate code for ${phoneNumber}`)
            }
        }, 1500)
    }

    return conn
}

// ====================== TELEGRAM COMMANDS ======================
bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, "❌ You are not the owner.")

    const raw = match[1]
    const phone = sanitizePhoneNumber(raw)

    if (!phone || phone.length < 8) {
        return bot.sendMessage(msg.chat.id, "❌ Invalid phone number. Example: 2348012345678")
    }

    bot.sendMessage(msg.chat.id, `⏳ Requesting pairing code for ${phone}...`)
    startWhatsAppBot(phone, msg.chat.id)
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, 
        "👋 *Habibi Pairing Bot Ready*\n\nUse /pair <phone number> to connect a new session.", 
        { parse_mode: 'Markdown' }
    )
})

bot.onText(/\/status/, (msg) => {
    if (!isOwner(msg)) return
    const count = activeSessions.size
    bot.sendMessage(msg.chat.id, `🟢 Active Sessions: ${count}`)
})

// Health check
app.get('/', (req, res) => res.send('Habibi is running ✅'))

app.listen(process.env.PORT || 3000, () => {
    console.log('🚀 Habibi server running on port', process.env.PORT || 3000)
    console.log('Send /start to your bot to begin.')
})
