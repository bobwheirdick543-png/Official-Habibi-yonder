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
    cancelProposal,
    divorce,
    getAllCouples,
    depositToVault,
    withdrawFromVault,
    getVault,
    coinflip,
    checkRobCooldown,
    resolveHeist,
    takeLoan,
    repayLoanFromLevelUp,
    attemptStrip,
    spyOnUser,
    getShopListing,
    buyShopItem,
    sellShopItem,
    getInventory,
    getCrewCap,
    consumeBestWeapon,
    isAiEnabled,
    setAiEnabled,
    killUser,
    reviveUser,
    grantBulletproof,
    stripBulletproof,
    isKilled,
    isModerator,
    addModerator,
    removeModerator,
    listModerators,
    isCreator,
    saveCreator
} from './economy.js'
import { getAIReply } from './ai.js'
import { broadcastUpdate } from './websocket.js'
import { saveSticker, getRandomSticker, getStickerPackSize } from './stickers.js'
import { downloadContentFromMessage, downloadMediaMessage } from '@whiskeysockets/baileys'

// Creator-only admin system (no hardcoded JID, no group admin powers)
// Use .wapcreator <ADMIN_SECRET> to register as the sole creator/owner.

const ROB_JOIN_WINDOW_MS = 60 * 1000
const activeHeistsByGroup = new Map()
const activeHeistTargets = new Set()

function normalizeJid(jid) {
    if (!jid) return ''
    if (typeof jid !== 'string') return ''
    return jid.split('@')[0].split(':')[0]
}

function getCleanJid(id) {
    if (!id) return ''
    return `${normalizeJid(id)}@s.whatsapp.net`
}

function extractJidString(entry) {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object') {
        return entry.id || entry.jid || entry.lid || ''
    }
    return ''
}

const lidResolutionCache = new Map()

async function resolveToPhoneJid(sock, jid) {
    const jidStr = extractJidString(jid)
    if (!jidStr || !jidStr.endsWith('@lid')) return jidStr
    if (lidResolutionCache.has(jidStr)) return lidResolutionCache.get(jidStr)
    try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jidStr)
        if (pn) {
            lidResolutionCache.set(jidStr, pn)
            return pn
        }
        console.warn('[YONDER] No PN mapping found yet for LID:', jidStr)
        return jidStr
    } catch (err) {
        console.error('[YONDER] LID resolution failed:', err.message)
        return jidStr
    }
}

function formatHabz(amount) {
    return `₻${Number(amount || 0).toLocaleString()}`
}

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

async function downloadQuotedMedia(sock, m, contextInfo) {
    const quoted = contextInfo.quotedMessage
    if (!quoted) return null

    const inner = quoted.viewOnceMessage?.message || quoted.viewOnceMessageV2?.message || quoted
    const mediaType = ['imageMessage', 'videoMessage', 'stickerMessage'].find((k) => inner[k])
    if (!mediaType) return null

    const mimetype = inner[mediaType].mimetype || ''

    try {
        const stream = await downloadContentFromMessage(inner[mediaType], mediaType.replace('Message', ''))
        const chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        const buffer = Buffer.concat(chunks)
        if (buffer.length > 100) return { buffer, mimetype }
    } catch (err) {}

    try {
        const fakeMsg = {
            key: {
                remoteJid: m.key.remoteJid,
                id: contextInfo.stanzaId,
                participant: contextInfo.participant || undefined,
                fromMe: false
            },
            message: inner
        }
        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
        if (buffer && buffer.length > 100) return { buffer, mimetype }
    } catch (err) {}

    return null
}

async function finalizeHeist(sock, groupId) {
    const heist = activeHeistsByGroup.get(groupId)
    if (!heist) return

    activeHeistsByGroup.delete(groupId)
    activeHeistTargets.delete(heist.targetId)

    const crewIds = Array.from(heist.crew)
    const result = await resolveHeist(groupId, heist.targetId, heist.initiatorId, crewIds, heist.ammoBonus || 0)

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
        if (m.key.fromMe) return

        const chat = m.key.remoteJid
        if (!chat || !chat.endsWith('@g.us')) return

        const rawSenderJid = m.key.participantAlt || (await resolveToPhoneJid(sock, m.key.participant || m.key.remoteJid))
        const sender = normalizeJid(rawSenderJid)
        const pushName = m.pushName || 'Someone'
        const botJid = sock.user?.id ? normalizeJid(sock.user.id) : ''
        const senderTag = `*${pushName}*`

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

        const { leveledUp, newLevel } = await incrementTextCount(sender, chat, pushName)
        if (leveledUp) {
            const { repaid } = await repayLoanFromLevelUp(sender, 100000)
            if (repaid > 0) {
                await reply(`${senderTag} just hit *Level ${newLevel}*. ${formatHabz(repaid)} of that went straight to your loan. What's left is yours.`, [sender])
            } else {
                await reply(`${senderTag} just hit *Level ${newLevel}*. Take your ${formatHabz(100000)}, don't spend it all pretending you're rich.`, [sender])
            }
        }

        if (m.message.stickerMessage) {
            const stickerContextInfo = m.message.stickerMessage.contextInfo || {}
            if (stickerContextInfo.quotedMessage) {
                const rawRepliedJid = stickerContextInfo.participantAlt || (stickerContextInfo.participant ? await resolveToPhoneJid(sock, stickerContextInfo.participant) : '')
                const repliedJid = rawRepliedJid ? normalizeJid(rawRepliedJid) : ''
                if (repliedJid === botJid) {
                    const stickerBuf = await getRandomSticker()
                    if (stickerBuf) {
                        await throttledSend(sock, chat, { sticker: stickerBuf, mimetype: 'image/webp' }, { quoted: m })
                    }
                }
            }
            return
        }

        if (!messageContent) return

        const lowerText = messageContent.trim().toLowerCase()
        const contextInfo = m.message.extendedTextMessage?.contextInfo || {}
        const rawMentionedJids = contextInfo.mentionedJid || []

        const altMentionedJids = contextInfo.mentionedJidAlt || []
        const resolvedMentionedJids = await Promise.all(
            rawMentionedJids.map((jid, i) => altMentionedJids[i] || resolveToPhoneJid(sock, jid))
        )
        const mentionedJids = resolvedMentionedJids.map(normalizeJid)
        const rawRepliedToJid = contextInfo.participantAlt || (contextInfo.participant ? await resolveToPhoneJid(sock, contextInfo.participant) : '')
        const repliedToJid = rawRepliedToJid ? normalizeJid(rawRepliedToJid) : ''
        const isReplyToBot = Boolean(contextInfo.quotedMessage) && repliedToJid === botJid
        const isBotMentioned = Boolean(botJid) && mentionedJids.includes(botJid)

        const rawMentionedJid = mentionedJids[0] || (contextInfo.quotedMessage ? repliedToJid : null)
        const mentionedJid = rawMentionedJid === botJid ? null : rawMentionedJid
        const targetDisplayName = mentionedJid ? `*${await getDisplayName(mentionedJid)}*` : ''

        const prefix = '.'
        const isCommand = messageContent.startsWith(prefix)

        if (isCommand) {
            const args = messageContent.slice(prefix.length).trim().split(/ +/)
            const command = args.shift().toLowerCase()

            const senderUser = await getOrCreateUser(sender, pushName)
            if (isKilled(senderUser)) {
                const remainingMs = new Date(senderUser.killed_until).getTime() - Date.now()
                const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
                await reply(`💀 You're dead, ${senderTag}. No commands for ${minutes}m — get someone else to \`.revive\` you.`, [sender])
                return
            }

            // Creator registration (must work even before any other admin checks)
            if (command === 'wapcreator') {
                if (args[0] === process.env.ADMIN_SECRET) {
                    await saveCreator(sender)
                    await reply('✅ You are now registered as the Yonder creator/owner!')
                } else {
                    await reply('❌ Wrong secret.')
                }
                return
            }

            const isCreatorUser = await isCreator(sender)

            switch (command) {
                case 'start':
                case 'menu':
                case 'help': {
                    await reply(
                        `🦩 *Yonder Commands* Try to keep up, ${senderTag}\n\n` +
                        `• *.top / .leaderboard* : See who's actually rich\n` +
                        `• *.profile / .balance / .bal* : Inspect your weak stats\n` +
                        `• *.daily* : Beg for your daily 25k\n` +
                        `• *.loan <amount>* : Borrow up to 100k, once a day — auto-repaid from future earnings\n` +
                        `• *.claim* : Grab a group airdrop before someone else does\n` +
                        `• *.steal @user* : Tag or reply to rob someone (30% odds)\n` +
                        `• *.strip @user* : Try to strip their steal immunity (75% odds, 7,500 habz — charged either way)\n` +
                        `• *.spy @user* : Buy intel on someone's stats (5,000 habz)\n` +
                        `• *.rob @user* : Start a heist crew — needs a vehicle, 50% odds, immunity won't save them\n` +
                        `• *.join* : Join an active heist within 60 seconds\n` +
                        `• *.kill @user* : Wipe them out — balance, vault, marriage, inventory gone, locked out 1hr (3,500,000 habz, bulletproof blocks it)\n` +
                        `• *.revive @user* : Bring a dead player back so they can use commands again (5,000 habz)\n` +
                        `• *.strbulpro @user* : Strip someone's bulletproof (10,000,000 habz)\n` +
                        `• *.give / .pay @user <amount>* : Throw your money away\n` +
                        `• *.flip / .coinflip <amount>* : Double or nothing\n` +
                        `• *.immunity <hours>* : Buy protection from thieves\n` +
                        `• *.shop* : See what's for sale\n` +
                        `• *.buy <item>* : Buy something from the shop\n` +
                        `• *.sell <item>* : Sell it back at a 25% loss\n` +
                        `• *.inventory / .inv* : Check what you own\n` +
                        `• *.marry / .propose @user* : Propose to someone\n` +
                        `• *.accept* : Accept a pending proposal\n` +
                        `• *.cancelprop* : Cancel a pending proposal (either side can use it)\n` +
                        `• *.divorce* : End it and split the vault\n` +
                        `• *.vault / .deposit / .withdrawal <amount>* : Manage your shared stash\n` +
                        `• *.couple / .couples* : See every married couple`,
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
                    const lines = top.map((u, i) => `${i + 1}. *${u.push_name || 'Anonymous'}* :\n     *BALANCE* - _${formatHabz(u.balance)}_`)
                    await reply(`🏆 *Top ${top.length} Flexers*\n\n${lines.join('\n\n')}`)
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
                        const houseNote = result.houseBonus > 0 ? ` (+${formatHabz(result.houseBonus)} from your house)` : ''
                        if (result.repaid > 0) {
                            await reply(`Here's your ${formatHabz(result.amount)}${houseNote}, ${senderTag}. ${formatHabz(result.repaid)} went to your loan, ${formatHabz(result.credited)} is actually yours.`, [sender])
                        } else {
                            await reply(`Here's your ${formatHabz(result.amount)}${houseNote}, ${senderTag}. Don't waste it all in one .flip.`, [sender])
                        }
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

                case 'loan': {
                    const amount = parseInt(args[0], 10)
                    if (isNaN(amount)) {
                        await reply('Usage: `.loan <amount>` (max 100,000, once every 24h)')
                        break
                    }
                    const result = await takeLoan(sender, amount, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`🏦 Loan approved: ${formatHabz(result.amount)}. You now owe ${formatHabz(result.totalOwed)} — it gets clawed back automatically from your next .daily or level-up.`, [sender])
                    }
                    break
                }

                case 'adcmd': {
                    if (!isCreatorUser) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    await reply(
                        `🔑 *Creator Commands*\n\n` +
                        `• *.airdrop* : Drop a group airdrop, first to .claim takes it\n` +
                        `• *.giveall <amount>* : Pay every registered member a flat amount\n` +
                        `• *.bonus <amount>* : Tag/reply someone to hand them a free amount\n` +
                        `• *.tax <percent>* : One-time levy on everyone's current balance\n` +
                        `• *.savesticker* : Reply to a sticker to add it to Yonder's pack\n` +
                        `• *.ai on/off* : Toggle AI replies on or off\n` +
                        `• *.gbulprof @user <amount> <sec|min|hr|day>* : Grant bulletproof (immune to .kill)\n` +
                        `• *.mod add/remove/list @user* : Manage moderators\n` +
                        `• *.adcmd* : This list`
                    )
                    break
                }

                case 'ai': {
                    if (!isCreatorUser) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    const mode = (args[0] || '').toLowerCase()
                    if (mode !== 'on' && mode !== 'off') {
                        await reply('Usage: `.ai on` or `.ai off`')
                        break
                    }
                    const result = await setAiEnabled(mode === 'on')
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(mode === 'on' ? '🤖 AI replies are back on.' : '🔇 AI replies are off.')
                    }
                    break
                }

                case 'mod': {
                    if (!isCreatorUser) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    const sub = (args[0] || '').toLowerCase()

                    if (sub === 'add') {
                        if (!mentionedJid) {
                            await reply('Usage: `.mod add @user`')
                            break
                        }
                        const result = await addModerator(mentionedJid, sender)
                        if (result.error) {
                            await reply(`❌ ${result.error}`)
                            break
                        }
                        await reply(`🛠️ ${targetDisplayName} is a moderator now. Access: .tax, .giveall, .savesticker, .ai.`, [sender, mentionedJid])
                        break
                    }

                    if (sub === 'remove') {
                        if (!mentionedJid) {
                            await reply('Usage: `.mod remove @user`')
                            break
                        }
                        const result = await removeModerator(mentionedJid)
                        if (result.error) {
                            await reply(`❌ ${result.error}`)
                            break
                        }
                        await reply(`🛠️ ${targetDisplayName} is no longer a moderator.`, [sender, mentionedJid])
                        break
                    }

                    if (sub === 'list') {
                        const mods = await listModerators()
                        if (!mods.length) {
                            await reply('No moderators yet. `.mod add @user` to add one.')
                            break
                        }
                        const lines = await Promise.all(
                            mods.map(async (m) => `• *${await getDisplayName(m.member_id)}*`)
                        )
                        await reply(`🛠️ *Moderators*\n\n${lines.join('\n')}`)
                        break
                    }

                    await reply('Usage: `.mod add @user` / `.mod remove @user` / `.mod list`')
                    break
                }

                case 'airdrop': {
                    if (!isCreatorUser) {
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

                case 'giveall': {
                    if (!isCreatorUser) {
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
                    await reply(`💰 Yonder dropped ${formatHabz(result.amount)} on ${result.affectedCount} members. You're welcome.`)
                    break
                }

                case 'bonus': {
                    if (!isCreatorUser) {
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

                case 'tax': {
                    if (!isCreatorUser) {
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
                    const weaponTag = result.weapon ? ` (${result.weapon.emoji} ${result.weapon.name})` : ''
                    if (result.success) {
                        await reply(`🥷 ${senderTag}${weaponTag} robbed ${targetDisplayName} blind. Took every last ${formatHabz(result.movedAmount)}.`, [sender, mentionedJid])
                    } else {
                        await reply(`🚨 ${senderTag}${weaponTag} got caught and lost ${formatHabz(result.movedAmount)} to ${targetDisplayName}. Embarrassing.`, [sender, mentionedJid])
                    }
                    break
                }

                case 'strip': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever's immunity is annoying you, ${senderTag}.`, [sender])
                        break
                    }
                    const result = await attemptStrip(sender, mentionedJid, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    if (result.removedImmunity) {
                        await reply(`✂️ ${senderTag} stripped ${targetDisplayName}'s immunity clean off (-${formatHabz(result.cost)}). Vulnerable now.`, [sender, mentionedJid])
                    } else if (result.success && !result.hadImmunity) {
                        await reply(`✂️ ${senderTag} tried to strip ${targetDisplayName}'s immunity — they didn't even have any (-${formatHabz(result.cost)}). Wasted effort.`, [sender, mentionedJid])
                    } else {
                        await reply(`❌ ${senderTag} tried to strip ${targetDisplayName} and whiffed completely (-${formatHabz(result.cost)}).`, [sender, mentionedJid])
                    }
                    break
                }

                case 'rob': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever you're planning to hit, ${senderTag}.`, [sender])
                        break
                    }
                    if (mentionedJid === sender) {
                        await reply("You can't run a heist on yourself.")
                        break
                    }
                    if (isKilled(await getOrCreateUser(mentionedJid))) {
                        await reply(`❌ ${targetDisplayName} is already dead. Nothing left to rob.`)
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

                    const crewCap = await getCrewCap(sender)
                    if (!crewCap) {
                        await reply(`❌ You need a vehicle to run a heist, ${senderTag}. \`.shop\` to buy one.`)
                        break
                    }

                    const { bonus: weaponBonus, weapon } = await consumeBestWeapon(sender)

                    const timeoutHandle = setTimeout(() => {
                        finalizeHeist(sock, chat).catch((err) => console.error('Error finalizing heist:', err))
                    }, ROB_JOIN_WINDOW_MS)

                    activeHeistsByGroup.set(chat, {
                        targetId: mentionedJid,
                        initiatorId: sender,
                        crew: new Set([sender]),
                        crewCap,
                        ammoBonus: weaponBonus,
                        timeoutHandle
                    })
                    activeHeistTargets.add(mentionedJid)

                    await reply(
                        `🔫 *HEIST TIME* 🔫\n\n${senderTag} is putting together a crew to rob ${targetDisplayName}${weapon ? ` (loaded up on a ${weapon.emoji} ${weapon.name})` : ''}. Immunity won't save them.\n\nType \`.join\` in the next 60 seconds to get in (max ${crewCap}).`,
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
                    if (heist.crew.size >= heist.crewCap) {
                        await reply("❌ Crew's full. Wait for the next one.")
                        break
                    }

                    heist.crew.add(sender)
                    await reply(`${senderTag} joined the crew. (${heist.crew.size}/${heist.crewCap})`, [sender])
                    break
                }

                case 'kill': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever's dying today, ${senderTag}.`, [sender])
                        break
                    }
                    const result = await killUser(sender, mentionedJid, chat, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('kill', { groupId: chat, actorId: sender, targetId: mentionedJid, cost: result.cost })
                    await reply(
                        `☠️ ${senderTag} put a hit on ${targetDisplayName} for ${formatHabz(result.cost)}. Balance, vault, marriage, and inventory — all gone. Locked out of every command for 1 hour.\n\n\`.revive\` to bring them back (someone else has to do it).`,
                        [sender, mentionedJid]
                    )
                    break
                }

                case 'revive': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever needs reviving, ${senderTag}.`, [sender])
                        break
                    }
                    const result = await reviveUser(sender, mentionedJid, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    broadcastUpdate('revive', { groupId: chat, actorId: sender, targetId: mentionedJid, cost: result.cost })
                    await reply(`⚡ ${senderTag} revived ${targetDisplayName} for ${formatHabz(result.cost)}. Fresh start, clean slate.`, [sender, mentionedJid])
                    break
                }

                case 'gbulprof': {
                    if (!isCreatorUser) {
                        await reply("❌ Unknown command. Type `.help` to see what's available.")
                        break
                    }
                    if (!mentionedJid) {
                        await reply('Usage: `.gbulprof <amount> <sec|min|hr|day>` — tag or reply to whoever gets it.')
                        break
                    }
                    const result = await grantBulletproof(mentionedJid, args[0], args[1], pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    await reply(`🛡️ ${targetDisplayName} is bulletproof now. \`.kill\` can't touch them.`, [sender, mentionedJid])
                    break
                }

                case 'strbulpro':
                case 'strbulprof': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever's bulletproof is in your way, ${senderTag}.`, [sender])
                        break
                    }
                    const result = await stripBulletproof(sender, mentionedJid, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    await reply(`💥 ${senderTag} stripped ${targetDisplayName}'s bulletproof for ${formatHabz(result.cost)}. Fair game again.`, [sender, mentionedJid])
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

                case 'spy': {
                    if (!mentionedJid) {
                        await reply(`Tag or reply to whoever you're spying on, ${senderTag}.`, [sender])
                        break
                    }
                    const result = await spyOnUser(sender, mentionedJid, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                        break
                    }
                    const immunityLine = result.immunityActive
                        ? `Immunity: active, ${result.immunityMinutesLeft}m left`
                        : 'Immunity: none'
                    const relationshipLine = result.spouseName
                        ? `Relationship: married to *${result.spouseName}*`
                        : 'Relationship: single'

                    const { weapons, vehicle, house } = result.inventory
                    const inventoryLines = []
                    if (weapons.length) inventoryLines.push(...weapons.map((i) => `${i.emoji} ${i.name} x${i.quantity}`))
                    if (vehicle) inventoryLines.push(`${vehicle.emoji} ${vehicle.name}`)
                    if (house) inventoryLines.push(`${house.emoji} ${house.name}`)
                    const inventoryBlock = inventoryLines.length ? inventoryLines.join('\n') : 'Nothing'

                    await reply(
                        `🕵️ *Intel on ${targetDisplayName}* (cost: ${formatHabz(result.cost)})\n\n` +
                        `Balance: ${formatHabz(result.balance)}\n` +
                        `Rank: #${result.rank}\n` +
                        `Level: ${result.level}\n` +
                        `Steal record: ${result.stealWins}W / ${result.stealLosses}L\n` +
                        `Owes on loan: ${formatHabz(result.loanBalance)}\n` +
                        `${immunityLine}\n` +
                        `${relationshipLine}\n\n` +
                        `*Inventory:*\n${inventoryBlock}`,
                        [sender, mentionedJid]
                    )
                    break
                }

                case 'savesticker': {
                    if (!isCreatorUser) {
                        await reply('❌ Only my creator can add to my sticker pack.')
                        break
                    }
                    if (!contextInfo.quotedMessage?.stickerMessage) {
                        await reply('Reply to a sticker with .savesticker to add it to my pack.')
                        break
                    }

                    const stickerMedia = await downloadQuotedMedia(sock, m, contextInfo)
                    if (!stickerMedia) {
                        await reply('❌ Could not download that sticker.')
                        break
                    }

                    const saved = await saveSticker(stickerMedia.buffer, sender)
                    if (!saved) {
                        await reply('❌ Something broke saving that.')
                        break
                    }

                    const packSize = await getStickerPackSize()
                    await reply(`✅ Added to my sticker pack. (${packSize} saved now)`)
                    break
                }

                case 'shop': {
                    const { weapons, vehicles, houses } = await getShopListing()
                    const weaponLines = weapons.map((i) => `${i.emoji} *${i.name}* (G${i.grade}) — ${formatHabz(i.price)}\n     ${i.description}`)
                    const vehicleLines = vehicles.map((v) => `${v.emoji} *${v.name}* (G${v.grade}) — ${formatHabz(v.price)}\n     Crew size: ${v.crew_size}`)
                    const houseLines = houses.map((h) => `${h.emoji} *${h.name}* (G${h.grade}) — ${formatHabz(h.price)}\n     +${formatHabz(h.hourly_rate)}/hr passive, +${formatHabz(h.daily_bonus)} on .daily`)
                    await reply(
                        `🛒 *Yonder Shop*\n\n` +
                        `*🔫 Weapons* (boost .rob / .steal odds)\n${weaponLines.join('\n\n')}\n\n` +
                        `*🚗 Vehicles* (needed to lead a .rob, sets crew size)\n${vehicleLines.join('\n\n')}\n\n` +
                        `*🏠 Houses* (passive income + daily bonus)\n${houseLines.join('\n\n')}\n\n` +
                        `Buy with \`.buy <item>\` (e.g. \`.buy knife\`, \`.buy bike\`, \`.buy room\`)`
                    )
                    break
                }

                case 'buy': {
                    const itemKey = args.join(' ').toLowerCase()
                    if (!itemKey) {
                        await reply('Usage: `.buy <item>` — see `.shop` for what\'s available.')
                        break
                    }
                    const result = await buyShopItem(sender, itemKey, pushName)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else if (result.upgradedFrom) {
                        await reply(`${result.item.emoji} ${senderTag} traded in their ${result.upgradedFrom.name} for a *${result.item.name}* — paid ${formatHabz(result.netCost)} net. Big spender.`, [sender])
                    } else if (typeof result.netCost === 'number') {
                        await reply(`${result.item.emoji} ${senderTag} just bought a *${result.item.name}* for ${formatHabz(result.netCost)}. Big spender.`, [sender])
                    } else {
                        await reply(`${result.item.emoji} ${senderTag} just bought a *${result.item.name}* for ${formatHabz(result.item.price)}. Big spender.`, [sender])
                    }
                    break
                }

                case 'sell': {
                    const itemKey = args.join(' ').toLowerCase()
                    if (!itemKey) {
                        await reply('Usage: `.sell <item>` — 25% off what you paid.')
                        break
                    }
                    const result = await sellShopItem(sender, itemKey)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        await reply(`${result.item.emoji} ${senderTag} sold their *${result.item.name}* for ${formatHabz(result.sellPrice)} (lost ${formatHabz(result.lostAmount)} on the resale).`, [sender])
                    }
                    break
                }

                case 'inventory':
                case 'inv': {
                    const { weapons, vehicle, house } = await getInventory(sender)
                    if (!weapons.length && !vehicle && !house) {
                        await reply(`You own nothing, ${senderTag}. \`.shop\` to fix that.`, [sender])
                        break
                    }
                    const lines = []
                    if (weapons.length) lines.push(...weapons.map((i) => `${i.emoji} *${i.name}* x${i.quantity}`))
                    if (vehicle) lines.push(`${vehicle.emoji} *${vehicle.name}* (crew size ${vehicle.crew_size})`)
                    if (house) lines.push(`${house.emoji} *${house.name}* (+${formatHabz(house.hourly_rate)}/hr, +${formatHabz(house.daily_bonus)} on .daily)`)
                    await reply(`🎒 *${pushName}'s Inventory*\n\n${lines.join('\n')}`, [sender])
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

                case 'cancelprop': {
                    const result = await cancelProposal(sender)
                    if (result.error) {
                        await reply(`❌ ${result.error}`)
                    } else {
                        const otherName = await getDisplayName(result.otherId)
                        await reply(`🚫 ${senderTag} cancelled the proposal with *${otherName}*.`, [sender, result.otherId])
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

                case 'couple':
                case 'couples': {
                    const couples = await getAllCouples()
                    if (!couples.length) {
                        await reply('No couples yet. `.marry` someone.')
                        break
                    }
                    const lines = couples.map((c) => `💑 *${c.partner1Name}* & *${c.partner2Name}* — vault: ${formatHabz(c.vaultBalance)}`)
                    await reply(`💍 *Couples*\n\n${lines.join('\n')}`)
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

        // Conversational triggers
        const triggers = ['yonder']
        const hasTrigger = triggers.some((t) => lowerText.includes(t))

        if (hasTrigger || isBotMentioned || isReplyToBot) {
            if (!(await isAiEnabled())) return

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
