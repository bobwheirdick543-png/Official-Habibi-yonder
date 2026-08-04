import {
    incrementTextCount,
    getOrCreateUser,
    getTopN,
    getProfile,
    claimDaily,
    claimGroupAirdrop,
    createGroupAirdrop,
    giveAllMembers,
    taxAllMembers,
    grantBonus,
    attemptSteal,
    giveMoney,
    buyImmunity,
    proposeMarriage,
    acceptMarriage,
    divorce,
    depositToVault,
    withdrawFromVault,
    getVault,
    coinflip,
    checkRobCooldown,
    resolveHeist
} from './economy.js'
import { getAIReply } from './ai.js'
import { broadcastUpdate } from './websocket.js'

// Hidden admin — only this JID can trigger .airdrop. Not shown in .help.
const ADMIN_JID = '2348132589873'

// .rob heist state — transient, in-memory only (the recruiting window is just
// 10 seconds, so losing this on a restart is an acceptable, rare edge case).
// Keyed by groupId, since that's what's available when someone types .join.
const ROB_JOIN_WINDOW_MS = 10 * 1000
const ROB_MAX_CREW = 5
const activeHeistsByGroup = new Map()
// Keyed by targetId, so the same person can't be targeted in two groups at once.
const activeHeistTargets = new Set()

function normalizeJid(jid) {
    if (!jid) return ''
    return jid.split('@')[0].split(':')[0]
}

function getCleanJid(id) {
    if (!id) return ''
    return `${normalizeJid(id)}@s.whatsapp.net`
}

// WhatsApp increasingly reports group participants using LID (linked identifier)
// JIDs instead of their real phone-number JID. Comparing a LID against a
// phone-number-based botJid (or storing it as member_id) silently fails/fragments
// data, so resolve every LID to its underlying phone-number JID first.
//
// The underlying Baileys mapping cache populates lazily and can be inconsistent
// call-to-call for the same contact (a documented upstream limitation), which was
// splitting single real people into duplicate economy accounts. This local sticky
// cache guarantees that once we successfully resolve a given LID once, every
// subsequent lookup in this process reuses that exact same answer instead of
// asking Baileys again and risking a different result.
const lidResolutionCache = new Map()

async function resolveToPhoneJid(sock, jid) {
    if (!jid || !jid.endsWith('@lid')) return jid
    if (lidResolutionCache.has(jid)) return lidResolutionCache.get(jid)
    try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid)
        if (pn) {
            lidResolutionCache.set(jid, pn)
            return pn
        }
        console.warn('[HABIBI] No PN mapping found yet for LID:', jid)
        return jid
    } catch (err) {
        console.error('[HABIBI] LID resolution failed:', err.message)
        return jid
    }
}

function formatHabz(amount) {
    return `₻${Number(amount || 0).toLocaleString()}`
}

// A newly-linked/automated number sending a burst of messages with no gap is a
// known trigger for WhatsApp's anti-spam system — this bites hardest right when
// the bot lands in a large, active group. This just adds a small, fixed gap
// between outbound sends so nothing fires back-to-back with zero delay.
const SEND_THROTTLE_MS = 400
let sendQueueTail = Promise.resolve()

function throttledSend(sock, jid, content, options) {
    const run = () => sock.sendMessage(jid, content, options)
    sendQueueTail = sendQueueTail.then(
        () => new Promise((resolve) => setTimeout(() => resolve(run()), SEND_THROTTLE_MS)),
        () => new Promise((resolve) => setTimeout(() => resolve(run()), SEND_THROTTLE_MS))
    )
    return sendQueueTail
}

async function getDisplayName(memberId, fallback = 'Someone') {
    if (!memberId) return fallback
    const user = await getOrCreateUser(memberId)
    return user?.push_name || fallback
}

// Fires once the 10-second recruiting window closes. Rolls the heist, pays
// everyone out, and announces the result — independent of whatever message
// triggered .rob in the first place, since that's long since been handled.
async function finalizeHeist(sock, groupId) {
    const heist = activeHeistsByGroup.get(groupId)
    if (!heist) return

    activeHeistsByGroup.delete(groupId)
    activeHeistTargets.delete(heist.targetId)

    const crewIds = Array.from(heist.crew)
    const result = await resolveHeist(groupId, heist.targetId, heist.initiatorId, crewIds)

    const targetName = await getDisplayName(heist.targetId)
    const allMentions = [...crewIds, heist.targetId]

    if (result.error) {
        await throttledSend(sock, groupId, { text: `❌ ${result.error}` })
        return
    }

    await sock.sendPresenceUpdate('composing', groupId)

    if (result.success) {
        await throttledSend(
            sock,
            groupId,
            {
                text: `🚨 *HEIST SUCCESSFUL* 🚨\n\nThe crew hit *${targetName}* for ${formatHabz(result.totalMoved)}. Each of the ${result.crewSize} member${result.crewSize > 1 ? 's' : ''} walks away with ${formatHabz(result.perMemberShare)}.`,
                mentions: allMentions.map(getCleanJid)
            }
        )
    } else {
        await throttledSend(
            sock,
            groupId,
            {
                text: `🚔 *HEIST FAILED* 🚔\n\nThe crew got caught. ${formatHabz(result.totalMoved)} total got paid out to *${targetName}* as compensation. Rookie mistake.`,
                mentions: allMentions.map(getCleanJid)
            }
        )
    }
}

export async function handleIncomingMessage(sock, m) {
    try {
        if (!m.message) return
        if (m.key.fromMe) return // never treat the bot's own outgoing messages as a user's

        const chat = m.key.remoteJid
        if (!chat || !chat.endsWith('@g.us')) return

        // Baileys gives the real phone-number JID directly via participantAlt when
        // the chat uses LID addressing — confirmed via debug logging. This is
        // deterministic and needs no async lookup or cache, unlike resolveToPhoneJid.
        const rawSenderJid = m.key.participantAlt || (await resolveToPhoneJid(sock, m.key.participant || m.key.remoteJid))
        const sender = normalizeJid(rawSenderJid)
        const pushName = m.pushName || 'Someone'
        const botJid = sock.user?.id ? normalizeJid(sock.user.id) : ''
        const senderTag = `*${pushName}*`

        // Silently tags people in `mentions` for notification purposes without
        // showing raw phone numbers in the visible text — the text itself should
        // always use real display names.
        const reply = async (text, silentMentions = []) => {
            const uniqueMentions = Array.from(new Set(silentMentions.map(getCleanJid).filter(Boolean)))

            await sock.sendPresenceUpdate('composing', chat)
            return throttledSend(
                sock,
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
        const rawMentionedJids = contextInfo.mentionedJid || []

        if (rawMentionedJids.length > 0 || contextInfo.quotedMessage) {
            console.log('[HABIBI DEBUG] contextInfo:', JSON.stringify({
                mentionedJid: contextInfo.mentionedJid,
                mentionedJidAlt: contextInfo.mentionedJidAlt,
                participant: contextInfo.participant,
                participantAlt: contextInfo.participantAlt,
                hasQuotedMessage: Boolean(contextInfo.quotedMessage)
            }))
        }

        // Prefer an explicit Alt (phone-number) field if Baileys provides one here too,
        // same as it does for the sender via m.key.participantAlt. Falls back to the
        // async lidMapping resolution when no Alt field is present.
        const altMentionedJids = contextInfo.mentionedJidAlt || []
        const resolvedMentionedJids = await Promise.all(
            rawMentionedJids.map((jid, i) => altMentionedJids[i] || resolveToPhoneJid(sock, jid))
        )
        const mentionedJids = resolvedMentionedJids.map(normalizeJid)
        const rawRepliedToJid = contextInfo.participantAlt || (contextInfo.participant ? await resolveToPhoneJid(sock, contextInfo.participant) : '')
        const repliedToJid = rawRepliedToJid ? normalizeJid(rawRepliedToJid) : ''
        const isReplyToBot = Boolean(contextInfo.quotedMessage) && repliedToJid === botJid
        const isBotMentioned = Boolean(botJid) && mentionedJids.includes(botJid)

        // Target resolution: explicit @mention takes priority, otherwise fall back to whoever they replied to.
        // Habibi's own JID is never a valid target — she's not a player.
        const rawMentionedJid = mentionedJids[0] || (contextInfo.quotedMessage ? repliedToJid : null)
        const mentionedJid = rawMentionedJid === botJid ? null : rawMentionedJid
        const targetDisplayName = mentionedJid ? `*${await getDisplayName(mentionedJid)}*` : ''

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
                        `• *.daily* : Beg for your daily 25k\n` +
                        `• *.claim* : Grab a group airdrop before someone else does\n` +
                        `• *.steal @user* : Tag or reply to rob someone (30% odds)\n` +
                        `• *.rob @user* : Start a heist crew (50% odds, immunity won't save them)\n` +
                        `• *.join* : Join an active heist within 10 seconds\n` +
                        `• *.give / .pay @user <amount>* : Throw your money away\n` +
                        `• *.flip / .coinflip <amount>* : Double or nothing\n` +
                        `• *.immunity <hours>* : Buy protection from thieves\n` +
                        `• *.marry / .propose @user* : Propose to someone\n` +
                        `• *.accept* : Accept a pending proposal\n` +
                        `• *.divorce* : End it and split the vault\n` +
                        `• *.vault / .deposit / .withdrawal <amount>* : Manage your shared stash`,
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
                    const top = await getTopN(20)
                    if (!top.length) {
                        await reply('Nobody has any money. Broke group.')
                        break
                    }
                    const mentions = top.map((u) => u.member_id)
                    const lines = top.map((u, i) => `${i + 1}. *${u.push_name || 'Anonymous'}* :\n     *BALANCE* - _${formatHabz(u.balance)}_`)
                    await reply(`🏆 *Top ${top.length} Flexers*\n\n${lines.join('\n\n')}`, mentions)
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

                case 'daily': {
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

                // Hidden admin-only command — deliberately absent from .help.
                // Non-admins get a generic unknown-command reply so its existence stays secret.
                case 'airdrop': {
                    if (sender !== ADMIN_JID) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    const result = await createGroupAirdrop(chat)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('airdrop_dropped', { groupId: chat, amount: result.amount })
                    await reply(`🪂 *AIRDROP INCOMING* 🪂\n\n${formatHabz(result.amount)} is up for grabs. First to type \`.claim\` takes it all.`)
                    break
                }

                // Hidden admin-only — pays every registered member of this group a flat amount.
                case 'giveall': {
                    if (sender !== ADMIN_JID) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    const amount = parseInt(args[0], 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.giveall <amount>`')
                        break
                    }
                    const result = await giveAllMembers(chat, amount)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('give_all', { groupId: chat, amount: result.amount, affectedCount: result.affectedCount })
                    await reply(`💰 Habibi dropped ${formatHabz(result.amount)} on ${result.affectedCount} members. You're welcome.`)
                    break
                }

                // Hidden admin-only — grants a specific amount to one tagged/replied member, free.
                case 'bonus': {
                    if (sender !== ADMIN_JID) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    if (!mentionedJid) {
                        await reply('Usage: `.bonus <amount>` — tag or reply to whoever gets it.')
                        break
                    }
                    const amount = parseInt(args.find((a) => /^\d+$/.test(a)), 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.bonus <amount>` — tag or reply to whoever gets it.')
                        break
                    }
                    const result = await grantBonus(mentionedJid, amount)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('bonus', { groupId: chat, targetId: mentionedJid, amount: result.amount })
                    await reply(`🎁 ${targetDisplayName} just got handed ${formatHabz(result.amount)} out of nowhere. Must be nice.`, [mentionedJid])
                    break
                }

                // Hidden admin-only — one-time levy: takes a percent of everyone's CURRENT balance, once.
                case 'tax': {
                    if (sender !== ADMIN_JID) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    const percent = parseFloat(args[0])
                    if (isNaN(percent)) {
                        await reply('Usage: `.tax <percent>` (e.g. `.tax 10`)')
                        break
                    }
                    const result = await taxAllMembers(chat, percent)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('tax', { groupId: chat, percent: result.percent, totalCollected: result.totalCollected, affectedCount: result.affectedCount })
                    await reply(`🏛️ The taxman came for ${result.percent}% of everyone's balance. ${formatHabz(result.totalCollected)} collected from ${result.affectedCount} members.`)
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

                // Group heist — tag or reply to a target, crew forms via .join for 10s,
                // then it resolves. Immunity (from .immunity) does NOT protect against this.
                case 'rob': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever you're planning to hit, ${senderTag}.`, [sender])
                        break
                    }
                    if (mentionedJid === sender) {
                        await reply("You can't run a heist on yourself.")
                        break
                    }
                    if (activeHeistsByGroup.has(chat)) {
                        await reply('❌ A heist is already being planned here. Wait for it to resolve.')
                        break
                    }
                    if (activeHeistTargets.has(mentionedJid)) {
                        await reply("❌ They're already being targeted somewhere else right now.")
                        break
                    }

                    const cooldown = await checkRobCooldown(mentionedJid)
                    if (cooldown.onCooldown) {
                        await reply(`❌ ${targetDisplayName} was already hit recently. Try again in ${cooldown.minutes}m.`)
                        break
                    }

                    const timeoutHandle = setTimeout(() => {
                        finalizeHeist(sock, chat).catch((err) => console.error('Error finalizing heist:', err))
                    }, ROB_JOIN_WINDOW_MS)

                    activeHeistsByGroup.set(chat, {
                        targetId: mentionedJid,
                        initiatorId: sender,
                        crew: new Set([sender]),
                        timeoutHandle
                    })
                    activeHeistTargets.add(mentionedJid)

                    await reply(
                        `🔫 *HEIST TIME* 🔫\n\n${senderTag} is putting together a crew to rob ${targetDisplayName}. Immunity won't save them.\n\nType \`.join\` in the next 10 seconds to get in (max ${ROB_MAX_CREW}).`,
                        [sender, mentionedJid]
                    )
                    break
                }

                case 'join': {
                    const heist = activeHeistsByGroup.get(chat)
                    if (!heist) {
                        await reply('❌ No heist happening right now.')
                        break
                    }
                    if (sender === heist.targetId) {
                        await reply("You can't join a heist against yourself.")
                        break
                    }
                    if (heist.crew.has(sender)) {
                        await reply(`You're already in on it, ${senderTag}.`, [sender])
                        break
                    }
                    if (heist.crew.size >= ROB_MAX_CREW) {
                        await reply("❌ Crew's full. Wait for the next one.")
                        break
                    }

                    heist.crew.add(sender)
                    await reply(`${senderTag} joined the crew. (${heist.crew.size}/${ROB_MAX_CREW})`, [sender])
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

                case 'withdrawal':
                case 'withdraw': {
                    const amount = parseInt(args[0], 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.withdrawal <amount>`')
                        break
                    }
                    const result = await withdrawFromVault(sender, amount)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`📤 ${senderTag} withdrew ${formatHabz(amount)} from the vault.`, [sender])
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
            await throttledSend(sock, chat, { text: aiReply }, { quoted: m })
        }
    } catch (err) {
        console.error('Error handling message:', err)
    }
}

const WELCOME_ROASTS = [
    "Oh great, another victim. Welcome, {name}. Try not to embarrass yourself.",
    "{name} just walked in. Nobody clapped.",
    "Welcome {name}. You've got 1000 habz and zero personality — let's see what you do with either.",
    "{name} joined. The bar was already on the floor, and you just tripped over it.",
    "Look who showed up: {name}. Type `.help` before you say something stupid.",
    "{name} has entered the chat. Lower your expectations accordingly."
]

// A single 'add' event listing more than this many people is a bulk event —
// someone mass-added a batch, or (in a large group especially) an edge case
// around initial sync — not individual joins worth roasting one by one.
// Firing a wall of back-to-back messages in that case is both spammy for the
// group and the exact pattern that gets a newly-linked automated number
// flagged by WhatsApp. Skip the roast entirely for bulk batches; still
// register the users so the economy tracks them from their first real message.
const BULK_ADD_THRESHOLD = 5

export async function handleGroupParticipantsUpdate(sock, update) {
    try {
        const { id: groupId, participants, action } = update
        if (action !== 'add' || !groupId?.endsWith('@g.us')) return

        const isBulkAdd = (participants || []).length > BULK_ADD_THRESHOLD

        for (const rawJid of participants || []) {
            const resolvedJid = await resolveToPhoneJid(sock, rawJid)
            const memberId = normalizeJid(resolvedJid)
            if (!memberId) continue

            const botJid = sock.user?.id ? normalizeJid(sock.user.id) : ''
            if (botJid && memberId === botJid) continue

            const user = await getOrCreateUser(memberId)

            if (isBulkAdd) continue

            const knownName = user?.push_name && user.push_name !== 'User' ? user.push_name : null
            const nameToken = knownName ? `*${knownName}*` : `@${memberId}`

            const roast = WELCOME_ROASTS[Math.floor(Math.random() * WELCOME_ROASTS.length)].replace('{name}', nameToken)

            await sock.sendPresenceUpdate('composing', groupId)
            await throttledSend(sock, groupId, { text: roast, mentions: [getCleanJid(memberId)] })
        }
    } catch (err) {
        console.error('Error handling group participants update:', err)
    }
}
