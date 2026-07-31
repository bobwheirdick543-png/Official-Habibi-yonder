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

export async function handleCommand(sock, msg, groupId, senderId, senderName, command, args, mentionedId) {
    const reply = (text, mentions) =>
        sock.sendMessage(groupId, { text, ...(mentions ? { mentions } : {}) }, { quoted: msg })

    switch (command) {
        case 'start':
        case 'help': {
            return reply(
                `🌵 *Habibi Menu — Try to follow along*\n\n` +
                `• *.profile* — Inspect your weak stats\n` +
                `• *.top* — See who is actually rich\n` +
                `• *.claim* — Beg for your free bread\n` +
                `• *.coinflip <amount>* — Waste your money\n` +
                `• *.steal* — Reply to rob someone\n` +
                `• *.give <amount>* — Reply to throw cash away\n` +
                `• *.buy immunity <hours>* — Hide behind protection\n` +
                `• *.marry* / *.accept* / *.divorce* — Relationship drama\n` +
                `• *.vault* / *.deposit <amount>* — Stash your coins`
            )
        }

        case 'top': {
            const top = await getTopN(20)
            if (top.length === 0) {
                return reply('🌵 Nobody is on the leaderboard. Y\'all are broke.')
            }
            const lines = top.map(
                (u, i) => `${i + 1}. ${u.push_name || u.member_id.split('@')[0]} — ${formatHabz(u.balance)}`
            )
            return reply(`🌵 *Top 20 Flexers*\n\n${lines.join('\n')}`)
        }

        case 'profile': {
            const profile = await getProfile(senderId)
            return reply(
                `🌵 *${senderName}'s Overrated Stats*\n\n` +
                    `Balance: ${formatHabz(profile.balance)}\n` +
                    `Rank: #${profile.rank}\n` +
                    `Level: ${profile.level}\n` +
                    `Texts: ${profile.text_count}\n` +
                    `Steals won: ${profile.stealWins}\n` +
                    `Steals lost: ${profile.stealLosses}`
            )
        }

        case 'claim': {
            const result = await claimAirdrop(senderId, groupId)
            if (result.error) return reply(`🌵 ${result.error}`)
            broadcastUpdate('airdrop_claimed', { groupId, memberId: senderId, senderName, amount: result.amount })
            return reply(`🌵 Take your handouts, ${senderName}. +${formatHabz(result.amount)}`)
        }

        case 'steal': {
            if (!mentionedId) {
                return reply('🌵 Mention someone to rob. Can you even target right?')
            }
            const result = await attemptSteal(senderId, mentionedId, groupId)
            if (result.error) return reply(`🌵 ${result.error}`)
            broadcastUpdate('steal', {
                groupId,
                stealerId: senderId,
                targetId: mentionedId,
                success: result.success,
                amount: result.movedAmount
            })
            if (result.success) {
                return reply(`🌵 ${senderName} snatched ${formatHabz(result.movedAmount)}. Robbery completed.`)
            }
            return reply(`🌵 ${senderName} got caught slipping. Paid ${formatHabz(result.movedAmount)} to the target. Pathetic.`)
        }

        case 'give': {
            if (!mentionedId) {
                return reply('🌵 Reply to whoever you are donating your money to.')
            }
            const amount = parseInt(args[0], 10)
            const result = await giveMoney(senderId, mentionedId, amount, groupId)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 ${senderName} threw ${formatHabz(result.amountReceived)} away (tax fee: ${formatHabz(result.fee)}).`)
        }

        case 'buy': {
            if (args[0] !== 'immunity') {
                return reply('🌵 Try typing: .buy immunity <hours>')
            }
            const hours = parseInt(args[1], 10)
            const result = await buyImmunity(senderId, hours, groupId)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 ${senderName} bought ${hours}h of immunity. Scared to get robbed?`)
        }

        case 'marry': {
            if (!mentionedId) {
                return reply('🌵 Reply to the unfortunate soul you want to marry.')
            }
            const result = await proposeMarriage(senderId, mentionedId)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 ${senderName} popped the question. Reply .accept if you actually want this.`, [mentionedId])
        }

        case 'accept': {
            const result = await acceptMarriage(senderId)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 Tied the knot. Don't come crying when it ends in divorce.`)
        }

        case 'divorce': {
            const result = await divorce(senderId)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 Divorced. Half the vault vanished, ${formatHabz(result.splitAmount)} each.`)
        }

        case 'vault': {
            const result = await getVault(senderId)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 Marriage Vault balance: ${formatHabz(result.vaultBalance)}`)
        }

        case 'deposit': {
            const amount = parseInt(args[0], 10)
            const result = await depositToVault(senderId, amount)
            if (result.error) return reply(`🌵 ${result.error}`)
            return reply(`🌵 Deposited ${formatHabz(amount)} into the vault.`)
        }

        case 'coinflip': {
            const amount = parseInt(args[0], 10)
            const result = await coinflip(senderId, amount, groupId)
            if (result.error) return reply(`🌵 ${result.error}`)
            broadcastUpdate('coinflip', { groupId, memberId: senderId, won: result.won, amount: result.amount })
            return reply(
                result.won
                    ? `🌵 You actually won? Pure luck. +${formatHabz(result.amount)}`
                    : `🌵 Lost it all. As expected. -${formatHabz(result.amount)}`
            )
        }

        default:
            return null
    }
                }
