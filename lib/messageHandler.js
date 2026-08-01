import { getOrCreateUser, ensureGroupExists, ensureGroupMembership, incrementTextCount } from './economy.js'
import { handleCommand } from './commands.js'
import { getAIReply } from './ai.js'
import { broadcastUpdate } from './websocket.js'

const PREFIX = '.'
const TRIGGER_WORDS = ['habibi', 'habs', 'bibi']

const knownGroups = new Set()
const knownMemberships = new Set()
const processedMsgIds = new Set()

function normalizeJid(jid) {
    if (!jid) return ''
    return jid.split('@')[0].split(':')[0]
}

function unwrapMessage(msg) {
    let m = msg.message
    if (!m) return null
    if (m.ephemeralMessage) m = m.ephemeralMessage.message
    if (m.viewOnceMessage) m = m.viewOnceMessage.message
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message
    return m
}

function getContextInfo(msg) {
    const m = unwrapMessage(msg)
    if (!m) return null
    return (
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        m.stickerMessage?.contextInfo ||
        null
    )
}

function extractText(msg) {
    const m = unwrapMessage(msg)
    if (!m) return ''
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    )
}

function extractRepliedToId(msg) {
    const context = getContextInfo(msg)
    return context?.participant || null
}

function extractMentionedIds(msg) {
    const context = getContextInfo(msg)
    return context?.mentionedJid || []
}

function isBotMentioned(msg, sock) {
    const context = getContextInfo(msg)
    const mentionedJids = context?.mentionedJid || []
    if (!mentionedJids.length) return false

    const normBotId = normalizeJid(sock.user?.id)
    const normBotLid = normalizeJid(sock.user?.lid)

    return mentionedJids.some((jid) => {
        const norm = normalizeJid(jid)
        return (normBotId && norm === normBotId) || (normBotLid && norm === normBotLid)
    })
}

function isReplyToBot(msg, sock) {
    const context = getContextInfo(msg)
    const repliedJid = context?.participant
    if (!repliedJid) return false

    const normReplied = normalizeJid(repliedJid)
    const normBotId = normalizeJid(sock.user?.id)
    const normBotLid = normalizeJid(sock.user?.lid)

    return (
        (normBotId && normReplied === normBotId) ||
        (normBotLid && normReplied === normBotLid)
    )
}

async function showTyping(sock, groupId) {
    try {
        await sock.sendPresenceUpdate('composing', groupId)
    } catch (err) {
        // Silently handle presence update errors
    }
}

async function ensureGroupCached(groupId) {
    if (knownGroups.has(groupId)) return
    await ensureGroupExists(groupId, null)
    knownGroups.add(groupId)
}

async function ensureMembershipCached(memberId, groupId, senderName) {
    const key = `${memberId}:${groupId}`
    if (knownMemberships.has(key)) return
    await ensureGroupMembership(memberId, groupId, senderName)
    knownMemberships.add(key)
}

export async function handleIncomingMessage(sock, msg) {
    if (!msg.message || msg.key.fromMe) return

    // Deduplicate incoming messages to prevent double responses
    const msgId = msg.key.id
    if (processedMsgIds.has(msgId)) return
    processedMsgIds.add(msgId)
    if (processedMsgIds.size > 500) {
        const first = processedMsgIds.values().next().value
        processedMsgIds.delete(first)
    }

    const remoteJid = msg.key.remoteJid
    const isGroup = remoteJid.endsWith('@g.us')

    if (!isGroup) return

    const senderId = msg.key.participant || remoteJid
    const senderName = msg.pushName || 'Someone'
    const groupId = remoteJid
    const text = extractText(msg).trim()

    if (!text) return

    await ensureGroupCached(groupId)
    await ensureMembershipCached(senderId, groupId, senderName)

    const rewardInfo = await incrementTextCount(senderId, groupId, senderName)

    if (rewardInfo && rewardInfo.rewards) {
        for (const reward of rewardInfo.rewards) {
            if (reward.type === 'text_reward') {
                await sock.sendMessage(groupId, {
                    text: `Look who actually talked enough. ${senderName} hit ${reward.textCount || 300} texts! +${reward.amount.toLocaleString()} Habz.`
                })
                broadcastUpdate('text_reward', { groupId, memberId: senderId, senderName, amount: reward.amount })
            }
            if (reward.type === 'level_up') {
                const levelDisplay = reward.level ? `Lvl ${reward.level}` : (reward.levelName || 'New Level')
                await sock.sendMessage(groupId, {
                    text: `${senderName} leveled up to *${levelDisplay}*! Don't let it go to your head. +${reward.amount.toLocaleString()} Habz.`
                })
                broadcastUpdate('level_up', {
                    groupId,
                    memberId: senderId,
                    senderName,
                    levelName: levelDisplay,
                    amount: reward.amount
                })
            }
        }
    }

    if (text.startsWith(PREFIX)) {
        await showTyping(sock, groupId)

        const [rawCommand, ...args] = text.slice(PREFIX.length).split(/\s+/)
        const command = rawCommand.toLowerCase()
        const mentionedId = extractRepliedToId(msg) || extractMentionedIds(msg)[0] || null

        await handleCommand(sock, msg, groupId, senderId, senderName, command, args, mentionedId)
        return
    }

    const isMention = isBotMentioned(msg, sock)
    const isReply = isReplyToBot(msg, sock)
    const hasTrigger = TRIGGER_WORDS.some((word) => text.toLowerCase().includes(word))

    const shouldReplyAsAI = isMention || isReply || hasTrigger

    if (shouldReplyAsAI) {
        await showTyping(sock, groupId)

        const aiReply = await getAIReply(senderId, senderName, text)
        await sock.sendMessage(groupId, { text: aiReply }, { quoted: msg })
    }
}

export async function handleGroupParticipantsUpdate(sock, update) {
    const { id: groupId, participants, action } = update

    if (action !== 'add') return

    await ensureGroupCached(groupId)

    for (const participant of participants) {
        const jid = typeof participant === 'string' ? participant : (participant.id || participant.jid || '')
        if (!jid) continue

        await sock.sendMessage(groupId, {
            text: `Great, another human joined. Welcome @${jid.split('@')[0]}. Try not to embarrass yourself.`,
            mentions: [jid]
        })
    }
}
