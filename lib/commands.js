import {
    attemptSteal,
    giveMoney,
    claimAirdrop,
    getTopN,
    getProfile,
    buyImmunity,
    proposeMarriage,
    acceptMarriage,
    divorce,
    depositToVault,
    getVault,
    coinflip
} from './economy.js'
import { broadcastUpdate } from './websocket.js'

function formatHabz(amount) {
    return `₻${amount.toLocaleString()}`
}

function normalizeJid(jid) {
    if (!jid) return ''
    return jid.split('@')[0].split(':')[0]
}

function getCleanJid(jid) {
    if (!jid) return ''
    return `${normalizeJid(jid)}@s.whatsapp.net`
}

function getTag(jid) {
    return `@${normalizeJid(jid)}`
}

export async function handleCommand(sock, msg, groupId, senderId, senderName, command, args, mentionedId) {
    const reply = (text, customMentions = []) => {
        // Automatically find all @phone numbers in the text string
        const textJids = [...text.matchAll(/@(\d+)/g)].map((m) => `${m[1]}@s.whatsapp.net`)
        
        // Combine explicitly passed JIDs with JIDs parsed from text
        const combined = [...customMentions.map(getCleanJid), ...textJids]
        const uniqueMentions = Array.from(new Set(combined.filter(Boolean)))

        return sock.sendMessage(
            groupId,
            {
                text,
                ...(uniqueMentions.length > 0 ? { mentions: uniqueMentions } : {})
            },
            { quoted: msg }
        )
    }

    const senderTag = getTag(senderId)
    const targetTag = mentionedId ? getTag(mentionedId) : ''

    switch (command) {
        case 'start':
        case 'help': {
            return reply(
                `*Habibi Menu for ${senderTag} : Try to follow along*\n\n` +
                `• *.profile* : Inspect your weak stats\n` +
                `• *.top* : See who is actually rich\n` +
                `• *.claim* : Beg for your free bread\n` +
                `• *.coinflip <amount>* : Waste your money\n` +
                `• *.steal* : Reply to rob someone\n` +
                `• *.give <amount>* : Reply to throw cash away\n` +
                `• *.buy immunity <hours>* : Hide behind protection\n` +
                `• *.marry* / *.accept* / *.divorce* : Relationship drama\n` +
                `• *.vault* / *.deposit <amount>* : Stash your coins`,
                [senderId]
            )
        }

        case 'top': {
            const top = await getTopN(20)
            if (top.length === 0) {
                return reply(`Nobody is on the leaderboard, ${senderTag}. You are all broke.`, [senderId])
            }

            let participantMap = new Map()
            try {
                const allGroups = await sock.groupFetchAllParticipating()
                for (const group of Object.values(allGroups)) {
                    for (const p of group.participants) {
                        const cleanId = normalizeJid(p.id)
                        const name = p.name || p.notify
                        if (name && !participantMap.has(cleanId)) {
                            participantMap.set(cleanId, name)
                        }
                    }
                }
            } catch (err) {
                // Ignore metadata lookup error
            }

            const topMentions = []

            const lines = top.map((u, i) => {
                const rawId = normalizeJid(u.member_id)
                topMentions.push(u.member_id)
                
                let displayName = u.push_name
                if (!displayName || /^\d+$/.test(displayName) || displayName.includes('User_') || displayName.includes('User ')) {
                    if (participantMap.has(rawId)) {
                        displayName = participantMap.get(rawId)
                    }
                }

                if (!displayName || /^\d+$/.test(displayName) || displayName.includes('User_') || displayName.includes('User ')) {
                    displayName = `User ${rawId.slice(-4)}`
                }

                return `${i + 1}. @${rawId} (${displayName}) : ${formatHabz(u.balance)}`
            })

            return reply(`*Top 20 Flexers*\n\n${lines.join('\n')}`, topMentions)
        }

        case 'profile': {
            const profile = await getProfile(senderId)
            return reply(
                `*${senderTag}'s Overrated Stats*\n\n` +
                    `Balance: ${formatHabz(profile.balance)}\n` +
                    `Rank: #${profile.rank}\n` +
                    `Level: Lvl ${profile.level}\n` +
                    `Texts: ${profile.text_count}\n` +
                    `Steals won: ${profile.stealWins}\n` +
                    `Steals lost: ${profile.stealLosses}`,
                [senderId]
            )
        }

        case 'claim': {
            const result = await claimAirdrop(senderId, groupId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            broadcastUpdate('airdrop_claimed', { groupId, memberId: senderId, senderName, amount: result.amount })
            return reply(`Take your handouts, ${senderTag}. +${formatHabz(result.amount)}`, [senderId])
        }

        case 'steal': {
            if (!mentionedId) {
                return reply(`Mention someone to rob, ${senderTag}. Can you even target right?`, [senderId])
            }
            const result = await attemptSteal(senderId, mentionedId, groupId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId, mentionedId])
            
            broadcastUpdate('steal', {
                groupId,
                stealerId: senderId,
                targetId: mentionedId,
                success: result.success,
                amount: result.movedAmount
            })
            if (result.success) {
                return reply(`${senderTag} snatched ${formatHabz(result.movedAmount)} from ${targetTag}. Robbery completed.`, [senderId, mentionedId])
            }
            return reply(`${senderTag} got caught slipping. Paid ${formatHabz(result.movedAmount)} to ${targetTag}. Pathetic.`, [senderId, mentionedId])
        }

        case 'give': {
            if (!mentionedId) {
                return reply(`Reply to or tag whoever you are donating your money to, ${senderTag}.`, [senderId])
            }
            const amount = parseInt(args[0], 10)
            const result = await giveMoney(senderId, mentionedId, amount, groupId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId, mentionedId])
            
            return reply(`${senderTag} threw ${formatHabz(result.amountReceived)} away to ${targetTag} (tax fee: ${formatHabz(result.fee)}).`, [senderId, mentionedId])
        }

        case 'buy': {
            if (args[0] !== 'immunity') {
                return reply(`Try typing: .buy immunity <hours>, ${senderTag}`, [senderId])
            }
            const hours = parseInt(args[1], 10)
            const result = await buyImmunity(senderId, hours, groupId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            return reply(`${senderTag} bought ${hours}h of immunity. Scared to get robbed?`, [senderId])
        }

        case 'marry': {
            if (!mentionedId) {
                return reply(`Reply to or tag the unfortunate soul you want to marry, ${senderTag}.`, [senderId])
            }
            const result = await proposeMarriage(senderId, mentionedId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId, mentionedId])
            
            return reply(`${senderTag} popped the question to ${targetTag}. Reply .accept if you actually want this.`, [senderId, mentionedId])
        }

        case 'accept': {
            const result = await acceptMarriage(senderId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            return reply(`${senderTag} tied the knot. Don't come crying when it ends in divorce.`, [senderId])
        }

        case 'divorce': {
            const result = await divorce(senderId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            return reply(`${senderTag} divorced. Half the vault vanished, ${formatHabz(result.splitAmount)} each.`, [senderId])
        }

        case 'vault': {
            const result = await getVault(senderId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            return reply(`${senderTag}'s Marriage Vault balance: ${formatHabz(result.vaultBalance)}`, [senderId])
        }

        case 'deposit': {
            const amount = parseInt(args[0], 10)
            const result = await depositToVault(senderId, amount)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            return reply(`${senderTag} deposited ${formatHabz(amount)} into the vault.`, [senderId])
        }

        case 'coinflip': {
            const amount = parseInt(args[0], 10)
            const result = await coinflip(senderId, amount, groupId)
            if (result.error) return reply(`${senderTag} ${result.error}`, [senderId])
            
            broadcastUpdate('coinflip', { groupId, memberId: senderId, won: result.won, amount: result.amount })
            return reply(
                result.won
                    ? `${senderTag} - You actually won? Pure luck. +${formatHabz(result.amount)}`
                    : `${senderTag} - Lost it all. As expected. ${formatHabz(result.amount)} lost.`,
                [senderId]
            )
        }

        default:
            return null
    }
        }
