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
        syncFullHistory: false
    })
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        
        if (connection === 'open') {
            console.log('✅ Habibi Connected!')
            bot.sendMessage(TELEGRAM_OWNER_ID, '✅ Habibi is now online!')
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            
            console.log('Connection closed. Code:', statusCode)
            
            if (shouldReconnect) {
                console.log('Reconnecting...')
                setTimeout(connectToWhatsApp, 5000)
            } else {
                bot.sendMessage(TELEGRAM_OWNER_ID, '❌ Habibi logged out.')
            }
        }
    })
    
    sock.ev.on('creds.update', saveCreds)
}

// Commands
bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, "❌ Owner only.")

    const phone = match[1].replace(/\D/g, '')
    if (!phone) return bot.sendMessage(msg.chat.id, "❌ Invalid number.")

    try {
        const code = await sock.requestPairingCode(phone)
        bot.sendMessage(msg.chat.id, `🔑 Pairing Code: ${code}\n\nWhatsApp > Linked Devices > Link with phone number`)
    } catch (e) {
        bot.sendMessage(msg.chat.id, "Failed to generate code.")
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, "👋 Send /pair <number> to connect.")
})

app.get('/', (req, res) => res.send('Habibi Running ✅'))

app.listen(process.env.PORT || 3000, () => {
    console.log('Server running')
    connectToWhatsApp()
})
