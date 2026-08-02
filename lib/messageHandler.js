import {
    incrementTextCount,
    getTopN,
    getProfile,
    claimAirdrop,
    attemptSteal,
    giveMoney,
    buyImmunity,
    proposeMarriage,
    acceptMarriage,
    divorce,
    depositToVault,
    getVault,
    coinflip
} from './economy.js'

export async function handleIncomingMessage(sock, m) {
    try {
        // DEBUG LOG TO TEST MESSAGE RECEIPT
        console.log('📩 [DEBUG] Incoming message event detected:', m?.key?.remoteJid)

        if (!m.message) return

        const chat = m.key.remoteJid

        // STRICT CHECK: GROUPS ONLY
        if (!chat || !chat.endsWith('@g.us')) return

        const sender = m.key.participant || m.key.remoteJid
        const pushName = m.pushName || 'Someone'
        const botJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : ''

        // 1. COUNT EVERY SINGLE GROUP MESSAGE
        await incrementTextCount(sender, chat, pushName)

        // Extract text across all message types
        const messageContent =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            m.message.videoMessage?.caption ||
            m.message.documentMessage?.caption ||
            ''

        if (!messageContent) return

        const lowerText = messageContent.trim().toLowerCase()
        const contextInfo = m.message.extendedTextMessage?.contextInfo || {}
        const mentionedJids = contextInfo.mentionedJid || []
        
        const isBotMentioned = botJid && (mentionedJids.includes(botJid) || contextInfo.participant === botJid)
        const prefix = '.'
        const isCommand = messageContent.startsWith(prefix)

        // --- 2. COMMAND HANDLER ---
        if (isCommand) {
            const args = messageContent.slice(prefix.length).trim().split(/ +/)
            const command = args.shift().
            
