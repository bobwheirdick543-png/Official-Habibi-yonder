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

function formatHabz(amount) {
    return `₻${amount.toLocaleString()}`
}

export async function handleCommand(sock, msg, groupId, senderId, senderName, command, args, mentionedId) {
    const reply = (text, mentions) =>
        sock.sendMessage(groupId, { text, ...(mentions ? { mentions } : {}) }, { quoted: msg })

    switch (command) {
        case 'top': {
            const top = await getTopN(20)
            if (top.length === 0) {
                return reply('🦩 No one on the leaderboard yet.')
            }
            const lines = top.map(
                (u, i) => `${i + 1}. ${u.push_name || u.member_id.split('@')[0]} — ${formatHabz(u.balance)}`
            )
            return reply(`🦩 *Global Top 20*\n\n${lines.join('\n')}`)
        }

        case 'profile': {
            const profile = await getProfile(senderId)
            return reply(
                `🦩 *${senderName}'s Profile*\n\n` +
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
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 ${senderName} claimed the airdrop! +${formatHabz(result.amount)}`)
        }

        case 'steal': {
            if (!mentionedId) {
                return reply('🦩 Reply to the person you want to steal from.')
            }
            const result = await attemptSteal(senderId, mentionedId, groupId)
            if (result.error) return reply(`🦩 ${result.error}`)
            if (result.success) {
                return reply(`🦩 ${senderName} stole ${formatHabz(result.movedAmount)}! Smooth criminal.`)
            }
            return reply(`🦩 ${senderName} got caught! Paid ${formatHabz(result.movedAmount)} to their target instead.`)
        }

        case 'give': {
            if (!mentionedId) {
                return reply('🦩 Reply to the person you want to give money to.')
            }
            const amount = parseInt(args[0], 10)
            const result = await giveMoney(senderId, mentionedId, amount, groupId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 ${senderName} sent ${formatHabz(result.amountReceived)} (fee: ${formatHabz(result.fee)})`)
        }

        case 'buy': {
            if (args[0] !== 'immunity') {
                return reply('🦩 Try: .buy immunity <hours>')
            }
            const hours = parseInt(args[1], 10)
            const result = await buyImmunity(senderId, hours, groupId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 ${senderName} bought ${hours}h of immunity.`)
        }

        case 'marry': {
            if (!mentionedId) {
                return reply('🦩 Reply to the person you want to marry.')
            }
            const result = await proposeMarriage(senderId, mentionedId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 ${senderName} popped the question! Reply .accept to make it official.`, [mentionedId])
        }

        case 'accept': {
            const result = await acceptMarriage(senderId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 It's official! Congrats to the happy couple.`)
        }

        case 'divorce': {
            const result = await divorce(senderId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 Divorced. Vault split, ${formatHabz(result.splitAmount)} each.`)
        }

        case 'vault': {
            const result = await getVault(senderId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 Vault balance: ${formatHabz(result.vaultBalance)}`)
        }

        case 'deposit': {
            const amount = parseInt(args[0], 10)
            const result = await depositToVault(senderId, amount)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(`🦩 Deposited ${formatHabz(amount)} to the vault.`)
        }

        case 'coinflip': {
            const amount = parseInt(args[0], 10)
            const result = await coinflip(senderId, amount, groupId)
            if (result.error) return reply(`🦩 ${result.error}`)
            return reply(
                result.won
                    ? `🦩 Coin landed your way! +${formatHabz(result.amount)}`
                    : `🦩 Not this time. -${formatHabz(result.amount)}`
            )
        }

        default:
            return null
    }
}
