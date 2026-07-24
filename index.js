import express from 'express'
import TelegramBot from 'node-telegram-bot-api'
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys'

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
        syncFullHistory: true
    })
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr && !sock.authState.creds.registered) {
            console.log('Ready for pairing via Telegram')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is ready. Send /pair <phone number>')
        }
        
        if (connection === 'open') {
            console.log('✅ Habibi Connected successfully!')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is now online!')
        }
        
        if (connection === 'close') {
            const shouldReconnect = 
                (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut)
            
            console.log('Connection closed:', lastDisconnect?.error?.message)
            
            if (shouldReconnect) {
                console.log('Reconnecting...')
                connectToWhatsApp()
            } else {
                console.log('Logged out.')
                bot.sendMessage(TELEGRAM_OWNER_ID, '❌ Habibi logged out.')
            }
        }
    })
    
    sock.ev.on('creds.update', saveCreds)
}

// Telegram Commands
bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, "❌ Owner only.")

    const phone = match[1].replace(/\D/g, '')
    if (!phone) return bot.sendMessage(msg.chat.id, "❌ Invalid number.")

    try {
        const code = await sock.requestPairingCode(phone)
        bot.sendMessage(msg.chat.id, `🔑 Pairing Code: ${code}\n\nWhatsApp > Linked Devices > Link a Device`)
    } catch (e) {
        bot.sendMessage(msg.chat.id, "Failed to generate code.")
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, "👋 Habibi pairing ready.\nUse /pair <number>")
})

app.get('/', (req, res) => res.send('Habibi Running'))

app.listen(process.env.PORT || 3000, () => {
    console.log('Server running')
    connectToWhatsApp()
})
