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
        if (!m.message) return

        const sender = m.key.participant || m.key.remoteJid
        const chat = m.key.remoteJid
        const pushName = m.pushName || 'Someone'

        // Counts every message regardless of type or chat
        await incrementTextCount(sender, chat, pushName)

        const messageContent =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            m.message.videoMessage?.caption ||
            m.message.documentMessage?.caption ||
            ''

        if (!messageContent) return

        const prefix = '.'
        if (!messageContent.startsWith(prefix)) return

        const args = messageContent.slice(prefix.length).trim().split(/ +/)
        const command = args.shift().toLowerCase()

        const mentionedJid =
            m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
            null

        switch (command) {
            case 'start':
            case 'menu':
            case 'help': {
                const menuText = `🤖 *HABIBI BOT COMMANDS*

📌 *General Commands*
• .start - Show command menu
• .ping - Test bot latency & status

💰 *Economy & Games*
• .top - View global balance leaderboard
• .profile - View your balance, rank & level
• .daily / .airdrop - Claim daily rewards
• .steal @user - Attempt to steal money
• .give @user <amount> - Transfer money
• .flip <amount> - Coinflip game
• .immunity <hours> - Buy protection from stealing

💍 *Marriage & Vault*
• .marry @user - Propose marriage to someone
• .accept - Accept a pending proposal
• .divorce - End marriage and split joint vault
• .vault - View joint marriage vault balance
• .deposit <amount> - Deposit money into joint vault`

                await sock.sendMessage(chat, { text: menuText }, { quoted: m })
                break
            }

            case 'ping': {
                const start = Date.now()
                const latency = Date.now() - start
                await sock.sendMessage(chat, { text: `🏓 *Pong!*\n⚡ Response time: *${latency}ms*` }, { quoted: m })
                break
            }

            case 'top':
            case 'leaderboard': {
                const topUsers = await getTopN(10)
                if (!topUsers.length) {
                    await sock.sendMessage(chat, { text: 'No economy data found yet!' }, { quoted: m })
                    break
                }
                let text = '🏆 *HABIBI TOP BALANCES* 🏆\n\n'
                topUsers.forEach((u, i) => {
                    text += `${i + 1}. *${u.push_name}*: ${u.balance.toLocaleString()} Habz\n`
                })
                await sock.sendMessage(chat, { text }, { quoted: m })
                break
            }

            case 'profile':
            case 'balance':
            case 'bal': {
                const prof = await getProfile(sender)
                const text = `👤 *PROFILE: ${pushName}*

💰 *Balance:* ${prof.balance.toLocaleString()} Habz
🏆 *Rank:* #${prof.rank}
⭐ *Level:* ${prof.level} (${prof.text_count} msgs)
⚔️ *Steal Stats:* ${prof.stealWins}W / ${prof.stealLosses}L
💍 *Married:* ${prof.spouseId ? `@${prof.spouseId}` : 'No'}
🏦 *Vault Share:* ${prof.vaultBalance.toLocaleString()} Habz`

                await sock.sendMessage(chat, { text, mentions: prof.spouseId ? [`${prof.spouseId}@s.whatsapp.net`] : [] }, { quoted: m })
                break
            }

            case 'daily':
            case 'airdrop': {
                const res = await claimAirdrop(sender, chat)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `🎉 You claimed *${res.amount.toLocaleString()} Habz* daily reward!` }, { quoted: m })
                }
                break
            }

            case 'steal': {
                if (!mentionedJid) {
                    await sock.sendMessage(chat, { text: '❌ Please tag a user to steal from: `.steal @user`' }, { quoted: m })
                    break
                }
                const res = await attemptSteal(sender, mentionedJid, chat)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else if (res.success) {
                    await sock.sendMessage(chat, { text: `🥷 Success! You stole *${res.movedAmount.toLocaleString()} Habz* from @${mentionedJid.split('@')[0]}!`, mentions: [mentionedJid] }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `🚨 Caught! You paid *${res.movedAmount.toLocaleString()} Habz* in fines to @${mentionedJid.split('@')[0]}!`, mentions: [mentionedJid] }, { quoted: m })
                }
                break
            }

            case 'give':
            case 'pay': {
                const amount = parseInt(args[1] || args[0])
                if (!mentionedJid || isNaN(amount)) {
                    await sock.sendMessage(chat, { text: '❌ Usage: `.give @user <amount>`' }, { quoted: m })
                    break
                }
                const res = await giveMoney(sender, mentionedJid, amount, chat)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `💸 Sent *${res.amountReceived.toLocaleString()} Habz* to @${mentionedJid.split('@')[0]} (Fee: ${res.fee} Habz).`, mentions: [mentionedJid] }, { quoted: m })
                }
                break
            }

            case 'flip':
            case 'coinflip': {
                const amount = parseInt(args[0])
                if (isNaN(amount)) {
                    await sock.sendMessage(chat, { text: '❌ Usage: `.flip <amount>`' }, { quoted: m })
                    break
                }
                const res = await coinflip(sender, amount, chat)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else if (res.won) {
                    await sock.sendMessage(chat, { text: `🪙 *WIN!* The coin landed in your favor. You won *${res.amount.toLocaleString()} Habz*!` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `🪙 *LOSS!* The coin landed against you. You lost *${res.amount.toLocaleString()} Habz*.` }, { quoted: m })
                }
                break
            }

            case 'immunity': {
                const hours = parseInt(args[0])
                if (isNaN(hours)) {
                    await sock.sendMessage(chat, { text: '❌ Usage: `.immunity <hours>` (2,000 Habz/hr)' }, { quoted: m })
                    break
                }
                const res = await buyImmunity(sender, hours, chat)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `🛡️ Purchased *${res.hours}h* of steal immunity for *${res.cost.toLocaleString()} Habz*!` }, { quoted: m })
                }
                break
            }

            case 'marry':
            case 'propose': {
                if (!mentionedJid) {
                    await sock.sendMessage(chat, { text: '❌ Tag someone to propose to: `.marry @user`' }, { quoted: m })
                    break
                }
                const res = await proposeMarriage(sender, mentionedJid)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `💍 @${sender.split('@')[0]} proposed to @${mentionedJid.split('@')[0]}!\nType \`.accept\` to accept!`, mentions: [sender, mentionedJid] }, { quoted: m })
                }
                break
            }

            case 'accept': {
                const res = await acceptMarriage(sender)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `🎉 Congratulations! @${sender.split('@')[0]} and @${res.spouseId} are now married! 🥂`, mentions: [sender, `${res.spouseId}@s.whatsapp.net`] }, { quoted: m })
                }
                break
            }

            case 'divorce': {
                const res = await divorce(sender)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `💔 Marriage ended. The joint vault was split, returning *${res.splitAmount.toLocaleString()} Habz* to each person.` }, { quoted: m })
                }
                break
            }

            case 'vault': {
                const res = await getVault(sender)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `🏦 *JOINT VAULT BALANCE*\nTotal Savings: *${res.vaultBalance.toLocaleString()} Habz*` }, { quoted: m })
                }
                break
            }

            case 'deposit': {
                const amount = parseInt(args[0])
                if (isNaN(amount)) {
                    await sock.sendMessage(chat, { text: '❌ Usage: `.deposit <amount>`' }, { quoted: m })
                    break
                }
                const res = await depositToVault(sender, amount)
                if (res.error) {
                    await sock.sendMessage(chat, { text: `❌ ${res.error}` }, { quoted: m })
                } else {
                    await sock.sendMessage(chat, { text: `📥 Deposited *${amount.toLocaleString()} Habz* into your joint vault!` }, { quoted: m })
                }
                break
            }
        }
    } catch (err) {
        console.error('Error handling message:', err)
    }
            }
            
export async function handleGroupParticipantsUpdate(sock, update) {
    try {
        // Participant update listener (joins/leaves)
        const { id, participants, action } = update
        // Optional logic for welcome/goodbye messages can be added here
    } catch (err) {
        console.error('Error handling group participants update:', err)
    }
}
