import express from 'express'
import http from 'http'
import TelegramBot from 'node-telegram-bot-api'
import baileysPkg from '@whiskeysockets/baileys'
import pino from 'pino'
import { useSupabaseAuthState } from './lib/supabaseAuthState.js'
import { handleIncomingMessage, handleGroupParticipantsUpdate } from './lib/messageHandler.js'
import { adminRouter } from './lib/adminApi.js'
import { initWebSocket } from './lib/websocket.js'

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileysPkg

const app = express()
const server = http.createServer(app)

app.use('/api', adminRouter)

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })

let sock = null
let isReadyForPairing = false
let reconnectAttempts = 0
let lastFailureNotifyTime = 0

function sanitizePhoneNumber(phone) {
    return phone.replace(/\D/g, '')
}

function isOwner(msg) {
    return String(msg.chat.id) === String(TELEGRAM_OWNER_ID)
}

function notifyOwner(text) {
    if (TELEGRAM_OWNER_ID) {
        bot.sendMessage(TELEGRAM_OWNER_ID, text)
    }
}

function notifyOwnerThrottled(text, minIntervalMs = 60000) {
    const now = Date.now()
    if (now - lastFailureNotifyTime > minIntervalMs) {
        lastFailureNotifyTime = now
        notifyOwner(text)
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState()
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'info' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: true
    })

    app.set('sock', sock)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr && !sock.authState.creds.registered && !isReadyForPairing) {
            isReadyForPairing = true
            notifyOwner('Habibi is ready to pair. Send /pair <phone number> (country code, no +).')
        }

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            console.log('Connection closed:', lastDisconnect?.error?.message)
            isReadyForPairing = false
            reconnectAttempts++
            const delay = Math.min(reconnectAttempts * 5000, 60000)

            if (shouldReconnect) {
                console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`)
                setTimeout(connectToWhatsApp, delay)
            } else {
                console.log(`Logged out. Retrying in ${delay / 1000}s (attempt ${reconnectAttempts})...`)
                notifyOwnerThrottled(
                    'Habibi keeps getting logged out and is retrying automatically. Watch for the ready-to-pair message.'
                )
                setTimeout(connectToWhatsApp, delay)
            }
        } else if (connection === 'open') {
            console.log('Habibi connected successfully')
            isReadyForPairing = false
            reconnectAttempts = 0
            notifyOwner('Habibi connected successfully.')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                await handleIncomingMessage(sock, msg)
            } catch (error) {
                console.error('Error handling message:', error)
            }
        }
    })

    sock.ev.on('group-participants.update', async (update) => {
        try {
            await handleGroupParticipantsUpdate(sock, update)
        } catch (error) {
            console.error('Error handling group participants update:', error)
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return

    if (!sock || !isReadyForPairing || sock.authState.creds.registered) {
        return bot.sendMessage(msg.chat.id, 'Not ready yet, or already paired.')
    }

    const sanitized = sanitizePhoneNumber(match[1])
    if (!sanitized) {
        return bot.sendMessage(msg.chat.id, 'Invalid phone number.')
    }

    try {
        const code = await sock.requestPairingCode(sanitized)
        bot.sendMessage(
            msg.chat.id,
            `Pairing code: ${code}\n\nWhatsApp > Linked Devices > Link a Device > Enter this code.`
        )
    } catch (error) {
        console.error('Failed to request pairing code:', error)
        bot.sendMessage(msg.chat.id, 'Failed to generate pairing code. Try again.')
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, 'Habibi pairing control online. Use /pair <phone number> once she says she is ready.')
})

app.get('/', (req, res) => {
    res.send('Habibi is running')
})

server.listen(process.env.PORT || 3000, () => {
    console.log('Health check server running')
    initWebSocket(server)
    connectToWhatsApp()
})
