import express from 'express'
import TelegramBot from 'node-telegram-bot-api'
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'

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
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false
    })
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr && !sock.authState.creds.registered) {
            console.log('Ready for pairing')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Ready for pairing. Send /pair <number>')
        }
        
        if (connection === 'open') {
            console.log('✅ Habibi Connected!')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is now online!')
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Connection closed:', lastDisconnect?.error?.message)
            
            if (shouldReconnect) {
                console.log('Reconnecting...')
                setTimeout(connectToWhatsApp, 5000)
            } else {
                bot.sendMessage(TELEGRAM_OWNER_ID, '❌ Logged out.')
            }
        }
    })
    
    sock.ev.on('creds.update', saveCreds)
    
    // Attach your message handler here
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            // Call your handler
            // await handleIncomingMessage(sock, msg)
        }
    })
}

// Telegram Commands
bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, "Owner only.")

    const phone = match[1].replace(/\D/g, '')
    if (!phone) return bot.sendMessage(msg.chat.id, "Invalid number.")

    try {
        const code = await sock.requestPairingCode(phone)
        bot.sendMessage(msg.chat.id, `🔑 Pairing Code: ${code}\n\nUse in WhatsApp > Linked Devices`)
    } catch (e) {
        bot.sendMessage(msg.chat.id, "Failed to generate code.")
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, "👋 Send /pair <number> to connect Habibi.")
})

app.get('/', (req, res) => res.send('Habibi Running'))

app.listen(process.env.PORT || 3000, () => {
    console.log('Server running')
    connectToWhatsApp()
})
