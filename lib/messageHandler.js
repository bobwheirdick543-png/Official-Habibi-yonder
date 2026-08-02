import {
    incrementTextCount,
    getOrCreateUser,
    getTopN,
    getProfile,
    claimDaily,
    claimGroupAirdrop,
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
import { getAIReply } from './ai.js'
import { broadcastUpdate } from './websocket.js'

function normalizeJid(jid) {
    if (!jid) return ''
    return jid.split('@')[0].split(':')[0]
}

function getCleanJid(id) {
    if (!id) return ''
    return `${normalizeJid(id)}@s.whatsapp.net`
}

function formatHabz(amount) {
    return `₻${Number(amount || 0).toLocaleString()}`
}

async function getDisplayName(memberId, fallback = 'Someone') {
    if (!memberId) return fallback
    const user = await getOrCreateUser(memberId)
    return user?.push_name || fallback
}

export async function handleIncomingMessage(sock, m) {
    try {
        if (!m.message) return

        const chat = m.key.remoteJid
        if (!chat || !chat.endsWith('@g.us')) return

        const rawSender = m.key.participant || m.key.remoteJid
        const sender = normalizeJid(rawSender)
        const pushName = m.pushName || 'Someone'
        const botJid = sock.user?.id ? normalizeJid(sock.user.id) : ''
        const senderTag = `*${pushName}*`

        // Silently tags people in `mentions` for notification purposes without
        // showing raw phone numbers in the visible text — the text itself should
        // always use real display names.
        const reply = async (text, silentMentions = []) => {
            const uniqueMentions = Array.from(new Set(silentMentions.map(getCleanJid).filter(Boolean)))

            await sock.sendPresenceUpdate('composing', chat)
            return sock.sendMessage(
                chat,
                { text, ...(uniqueMentions.length > 0 ? { mentions: uniqueMentions } : {}) },
                { quoted: m }
            )
        }

        const messageContent =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            m.message.videoMessage?.caption ||
            m.message.documentMessage?.caption ||
            ''

        // 1. COUNT EVERY GROUP MESSAGE + HANDLE LEVEL UPS
        const { leveledUp, newLevel } = await incrementTextCount(sender, chat, pushName)
        if (leveledUp) {
            await reply(`${senderTag} just hit *Level ${newLevel}*. Take your ${formatHabz(100000)}, don't spend it all pretending you're rich.`, [sender])
        }

        if (!messageContent) return

        const lowerText = messageContent.trim().toLowerCase()
        const contextInfo = m.message.extendedTextMessage?.contextInfo || {}
        const mentionedJids = (contextInfo.mentionedJid || []).map(normalizeJid)
        const repliedToJid = contextInfo.participant ? normalizeJid(contextInfo.participant) : ''
        const isReplyToBot = Boolean(contextInfo.quotedMessage) && repliedToJid === botJid
        const isBotMentioned = Boolean(botJid) && mentionedJids.includes(botJid)

        // Target resolution: explicit @mention takes priority, otherwise fall back to whoever they replied to
        const mentionedJid = mentionedJids[0] || (contextInfo.quotedMessage ? repliedToJid : null)
        const targetDisplayName = mentionedJid ? `*${await getDisplayName(mentionedJid)}*` : ''

        // TEMP DEBUG — remove once tag/reply detection is confirmed working.
        // If mentionedJids/repliedToJid never match botJid, WhatsApp is likely
        // sending LID-based identifiers instead of phone-number JIDs here.
        if (mentionedJids.length > 0 || contextInfo.quotedMessage) {
            console.log('[HABIBI DEBUG] botJid:', botJid, '| mentionedJids:', mentionedJids, '| repliedToJid:', repliedToJid, '| isBotMentioned:', isBotMentioned, '| isReplyToBot:', isReplyToBot)
        }

        const prefix = '.'
        const isCommand = messageContent.startsWith(prefix)

        // --- 2. COMMAND HANDLER ---
        if (isCommand) {
            const args = messageContent.slice(prefix.length).trim().split(/ +/)
            const command = args.shift().toLowerCase()

            switch (command) {
                case 'start':
                case 'menu':
                case 'help': {
                    await reply(
                        `🦩 *Habibi Commands* Try to keep up, ${senderTag}\n\n` +
                        `• *.top / .leaderboard* : See who's actually rich\n` +
                        `• *.profile / .balance / .bal* : Inspect your weak stats\n` +
                        `• *.daily / .airdrop* : Beg for your daily 25k\n` +
                        `• *.claim* : Grab a group airdrop before someone else does\n` +
                        `• *.steal @user* : Tag or reply to rob someone (30% odds)\n` +
                        `• *.give / .pay @user <amount>* : Throw your money away\n` +
                        `• *.flip / .coinflip <amount>* : Double or nothing\n` +
                        `• *.immunity <hours>* : Buy protection from thieves\n` +
                        `• *.marry / .propose @user* : Propose to someone\n` +
                        `• *.accept* : Accept a pending proposal\n` +
                        `• *.divorce* : End it and split the vault\n` +
                        `• *.vault / .deposit <amount>* : Manage your shared stash`,
                        [sender]
                    )
                    break
                }

                case 'ping': {
                    const start = Date.now()
                    const latency = Date.now() - start
                    await reply(`🏓 Still here, unfortunately. ${latency}ms.`)
                    break
                }

                case 'top':
                case 'leaderboard': {
                    const top = await getTopN(10)
                    if (!top.length) {
                        await reply('Nobody has any money. Broke group.')
                        break
                    }
                    const mentions = top.map((u) => u.member_id)
                    const lines = top.map((u, i) => `${i + 1}. *${u.push_name || 'Anonymous'}* : ${formatHabz(u.balance)}`)
                    await reply(`🏆 *Top 10 Flexers*\n\n${lines.join('\n')}`, mentions)
                    break
                }

                case 'profile':
                case 'balance':
                case 'bal': {
                    const profile = await getProfile(sender)
                    const spouseName = profile.spouseId ? await getDisplayName(profile.spouseId) : null
                    const spouseLine = spouseName ? `Married to: *${spouseName}*` : 'Married to: nobody, shocking'
                    await reply(
                        `*${pushName}'s Overrated Stats*\n\n` +
                        `Balance: ${formatHabz(profile.balance)}\n` +
                        `Rank: #${profile.rank}\n` +
                        `Level: ${profile.level} (${profile.text_count} msgs)\n` +
                        `Steal record: ${profile.stealWins}W / ${profile.stealLosses}L\n` +
                        `${spouseLine}\n` +
                        `Vault: ${formatHabz(profile.vaultBalance)}`,
                        [sender, ...(profile.spouseId ? [profile.spouseId] : [])]
                    )
                    break
                }

                case 'daily':
                case 'airdrop': {
                    const result = await claimDaily(sender, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`Here's your ${formatHabz(result.amount)}, ${senderTag}. Don't waste it all in one .flip.`, [sender])
                    }
                    break
                }

                case 'claim': {
                    const result = await claimGroupAirdrop(sender, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        broadcastUpdate('airdrop_claimed', { groupId: chat, memberId: sender, senderName: pushName, amount: result.amount })
                        await reply(`${senderTag} snatched the airdrop. +${formatHabz(result.amount)}`, [sender])
                    }
                    break
                }

                case 'steal': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to someone to rob them, ${senderTag}. Can you even aim?`, [sender])
                        break
                    }
                    const result = await attemptSteal(sender, mentionedJid, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('steal', { groupId: chat, stealerId: sender, targetId: mentionedJid, success: result.success, amount: result.movedAmount })
                    if (result.success) {
                        await reply(`🥷 ${senderTag} robbed ${targetDisplayName} blind. Took every last ${formatHabz(result.movedAmount)}.`, [sender, mentionedJid])
                    } else {
                        await reply(`🚨 ${senderTag} got caught and lost ${formatHabz(result.movedAmount)} to ${targetDisplayName}. Embarrassing.`, [sender, mentionedJid])
                    }
                    break
                }

                case 'give':
                case 'pay': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever's getting your money, ${senderTag}.`, [sender])
                        break
                    }
                    const amount = parseInt(args.find((a) => /^\d+$/.test(a)), 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.give @user <amount>`')
                        break
                    }
                    const result = await giveMoney(sender, mentionedJid, amount, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`💸 ${senderTag} threw ${formatHabz(result.amountReceived)} at ${targetDisplayName} (fee: ${formatHabz(result.fee)}).`, [sender, mentionedJid])
                    }
                    break
                }

                case 'flip':
                case 'coinflip': {
                    const amount = parseInt(args[0], 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.flip <amount>`')
                        break
                    }
                    const result = await coinflip(sender, amount, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('coinflip', { groupId: chat, memberId: sender, won: result.won, amount: result.amount })
                    await reply(
                        result.won
                            ? `🪙 ${senderTag} actually won. Pure luck. +${formatHabz(result.amount)}`
                            : `🪙 ${senderTag} lost it all. As expected. -${formatHabz(result.amount)}`,
                        [sender]
                    )
                    break
                }

                case 'immunity': {
                    const hours = parseInt(args[0], 10)
                    if (isNaN(hours)) {
                        await reply('Usage: `.immunity <hours>` (2,000 habz/hr)')
                        break
                    }
                    const result = await buyImmunity(sender, hours, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`🛡️ ${senderTag} bought ${result.hours}h of immunity for ${formatHabz(result.cost)}. Scared?`, [sender])
                    }
                    break
                }

                case 'marry':
                case 'propose': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever you're proposing to, ${senderTag}.`, [sender])
                        break
                    }
                    const result = await proposeMarriage(sender, mentionedJid, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`💍 ${senderTag} proposed to ${targetDisplayName}. Type \`.accept\` if you're actually into this.`, [sender, mentionedJid])
                    }
                    break
                }

                case 'accept': {
                    const result = await acceptMarriage(sender)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        const spouseName = await getDisplayName(result.spouseId)
                        await reply(`🎉 ${senderTag} and *${spouseName}* are married now. Don't come crying when it ends in \`.divorce\`.`, [sender, result.spouseId])
                    }
                    break
                }

                case 'divorce': {
                    const result = await divorce(sender)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`💔 ${senderTag}'s marriage is over. Vault split, ${formatHabz(result.splitAmount)} each.`, [sender])
                    }
                    break
                }

                case 'vault': {
                    const result = await getVault(sender)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`🏦 Vault balance: ${formatHabz(result.vaultBalance)}`)
                    }
                    break
                }

                case 'deposit': {
                    const amount = parseInt(args[0], 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.deposit <amount>`')
                        break
                    }
                    const result = await depositToVault(sender, amount)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`📥 ${senderTag} deposited ${formatHabz(amount)} into the vault.`, [sender])
                    }
                    break
                }
            }
            return
        }

        // --- 3. CONVERSATIONAL TRIGGERS: TAGS, MENTIONS, REPLIES ---
        const triggers = ['habibi', 'bibi', 'habs']
        const hasTrigger = triggers.some((t) => lowerText.includes(t))

        if (hasTrigger || isBotMentioned || isReplyToBot) {
            await sock.sendPresenceUpdate('composing', chat)
            const aiReply = await getAIReply(sender, pushName, messageContent)
            await sock.sendPresenceUpdate('paused', chat)
            await sock.sendMessage(chat, { text: aiReply }, { quoted: m })
        }
    } catch (err) {
        console.error('Error handling message:', err)
    }
}

export async function handleGroupParticipantsUpdate(sock, update) {
    try {
        const { id, participants, action } = update
        // Reserved for future welcome/leave logic.
    } catch (err) {
        console.error('Error handling group participants update:', err)
    }
}
