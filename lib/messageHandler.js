import { getOrCreateUser, ensureGroupExists, ensureGroupMembership, incrementTextCount } from './economy.js'
import { handleCommand } from './commands.js'
import { getAIReply } from './ai.js'
import { broadcastUpdate } from './websocket.js'

const PREFIX = '.'
const TRIGGER_WORDS = ['habibi', 'habs', 'bibi']

const knownGroups = new Set()
const knownMemberships = new Set()

function normalizeJid(jid) {
    if (!jid) return jid
    return jid.replace(/:\d+@/, '@')
}

function extractText(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ''
    )
}

function extractRepliedToId(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.participant || null
}

function extractMentionedIds(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
}

function isBotMentioned(msg, botId) {
    if (!botId) return false
    const normalizedBotId = normalizeJid(botId)
    return extractMentionedIds(msg).some((jid) => normalizeJid(jid) === normalizedBotId)
}

function isReplyToBot(msg, botId) {
    if (!botId) return false
    return normalizeJid(extractRepliedToId(msg)) === normalizeJid(botId)
}

async function ensureGroupCached(groupId) {
    if (knownGroups.has(groupId)) return
    await ensureGroupExists(groupId, null)
    knownGroups.add(groupId)
}

async function ensureMembershipCached(memberId, groupId) {
    const key = `${memberId}:${groupId}`
    if (knownMemberships.has(key)) return
    await ensureGroupMembership(memberId, groupId)
    knownMemberships.add(key)
}

export async function handleIncomingMessage(sock, msg) {
    if (!msg.message || msg.key.fromMe) return

    const remoteJid = msg.key.remoteJid
    const isGroup = remoteJid.endsWith('@g.us')

    if (!isGroup) return

    const senderId = msg.key.participant || remoteJid
    const senderName = msg.pushName || 'Someone'
    const groupId = remoteJid
    const text = extractText(msg).trim()

    if (!text) return

    await ensureGroupCached(groupId)
    await ensureMembershipCached(senderId, groupId)

    const rewardInfo = await incrementTextCount(senderId, groupId)

    for (const reward of rewardInfo.rewards) {
        if (reward.type === 'text_reward') {
            await sock.sendMessage(groupId, {
                text: `🦩 ${senderName} hit 300 texts! +${reward.amount.toLocaleString()} Habz`
            })
            broadcastUpdate('text_reward', { groupId, memberId: senderId, senderName, amount: reward.amount })
        }
        if (reward.type === 'level_up') {
            await sock.sendMessage(groupId, {
                text: `🦩 ${senderName} leveled up to *${reward.levelName}*! +${reward.amount.toLocaleString()} Habz`
            })
            broadcastUpdate('level_up', {
                groupId,
                memberId: senderId,
                senderName,
                levelName: reward.levelName,
                amount: reward.amount
            })
        }
    }

    if (text.startsWith(PREFIX)) {
        const [rawCommand, ...args] = text.slice(PREFIX.length).split(/\s+/)
        const command = rawCommand.toLowerCase()
        const mentionedId = extractRepliedToId(msg) || extractMentionedIds(msg)[0] || null

        await handleCommand(sock, msg, groupId, senderId, senderName, command, args, mentionedId)
        return
    }

    const botId = sock.user?.id
    const shouldReplyAsAI =
        isBotMentioned(msg, botId) ||
        isReplyToBot(msg, botId) ||
        TRIGGER_WORDS.some((word) => text.toLowerCase().includes(word))

    if (shouldReplyAsAI) {
        const aiReply = await getAIReply(senderId, senderName, text)
        await sock.sendMessage(groupId, { text: aiReply }, { quoted: msg })
    }
}

export async function handleGroupParticipantsUpdate(sock, update) {
    const { id: groupId, participants, action } = update

    if (action !== 'add') return

    await ensureGroupCached(groupId)

    for (const participant of participants) {
        await sock.sendMessage(groupId, {
            text: `🦩 Welcome @${participant.split('@')[0]}! Glad to have you.`,
            mentions: [participant]
        })
    }
}
