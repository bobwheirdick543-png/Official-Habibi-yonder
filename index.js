import express from 'express'
import TelegramBot from 'node-telegram-bot-api'
import { 
    makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers 
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { handleIncomingMessage, handleGroupParticipantsUpdate } from './lib/messageHandler.js'

const app = express()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })

let sock = null

function isOwner(msg) {
    return String(msg.chat.id) === String(TELEGRAM_OWNER_ID)
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('QR Code received (for fallback)')
        }

        if (connection === 'open') {
            console.log('✅ Habibi Connected Successfully!')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is now online and connected.')
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) {
                console.log('Reconnecting...')
                setTimeout(connectToWhatsApp, 5000)
            }
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            await handleIncomingMessage(sock, msg).catch(console.error)
        }
    })

    sock.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantsUpdate(sock, update).catch(console.error)
    })

    sock.ev.on('creds.update', saveCreds)
}

// Telegram Commands
bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, "Owner only.")

    const phone = match[1].replace(/\D/g, '')
    if (!phone) return bot.sendMessage(msg.chat.id, "Invalid number.")

    bot.sendMessage(msg.chat.id, `Requesting pairing code for ${phone}...`)

    try {
        const code = await sock.requestPairingCode(phone)
        bot.sendMessage(msg.chat.id, `🔑 Pairing Code: ${code}\n\nUse in WhatsApp > Linked Devices`)
    } catch (e) {
        bot.sendMessage(msg.chat.id, "Failed to generate code. Try again.")
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, "👋 Habibi is ready.\nUse /pair <number> to connect.")
})

app.get('/', (req, res) => res.send('Habibi Running'))

app.listen(process.env.PORT || 3000, () => {
    console.log('Server running')
    connectToWhatsApp()
})
