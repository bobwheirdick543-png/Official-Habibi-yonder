import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY
export const supabase = createClient(supabaseUrl, supabaseKey)

function normalizeJid(jid) {
    if (!jid) return ''
    return jid.split('@')[0].split(':')[0]
}

export async function getOrCreateUser(memberId, pushName = 'Someone') {
    const cleanId = normalizeJid(memberId)
    if (!cleanId) return null

    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('member_id', cleanId)
            .maybeSingle()

        if (data) {
            if (pushName && pushName !== 'Someone' && data.push_name !== pushName) {
                await supabase
                    .from('users')
                    .update({ push_name: pushName })
                    .eq('member_id', cleanId)
            }
            return data
        }

        const newUser = {
            member_id: cleanId,
            push_name: pushName || `User ${cleanId.slice(-4)}`,
            balance: 1000,
            text_count: 0,
            level: 1,
            steal_wins: 0,
            steal_losses: 0,
            immunity_until: null,
            spouse_id: null,
            vault_balance: 0,
            last_airdrop: null
        }

        const { data: created, error: createErr } = await supabase
            .from('users')
            .insert([newUser])
            .select()
            .single()

        if (createErr) {
            console.error('Error creating user record:', createErr)
            return newUser
        }

        return created
    } catch (err) {
        console.error('Exception in getOrCreateUser:', err)
        return null
    }
}

export async function ensureGroupExists(groupId, groupName = null) {
    try {
        const { data } = await supabase
            .from('groups')
            .select('group_id')
            .eq('group_id', groupId)
            .maybeSingle()

        if (!data) {
            await supabase.from('groups').insert([{ group_id: groupId, group_name: groupName }])
        }
    } catch (err) {
        console.error('Error in ensureGroupExists:', err)
    }
}

export async function ensureGroupMembership(memberId, groupId, senderName) {
    try {
        const cleanId = normalizeJid(memberId)
        await getOrCreateUser(cleanId, senderName)

        const { data } = await supabase
            .from('group_members')
            .select('*')
            .eq('member_id', cleanId)
            .eq('group_id', groupId)
            .maybeSingle()

        if (!data) {
            await supabase.from('group_members').insert([{ member_id: cleanId, group_id: groupId }])
        }
    } catch (err) {
        console.error('Error in ensureGroupMembership:', err)
    }
}

export async function incrementTextCount(memberId, groupId, senderName) {
    try {
        const cleanId = normalizeJid(memberId)
        let user = await getOrCreateUser(cleanId, senderName)

        if (!user) {
            user = {
                member_id: cleanId,
                push_name: senderName || `User ${cleanId.slice(-4)}`,
                text_count: 0,
                balance: 1000,
                level: 1
            }
        }

        const currentCount = (user.text_count || 0) + 1
        const newLevel = Math.floor(currentCount / 100) + 1
        const currentLevel = user.level || 1
        const leveledUp = newLevel > currentLevel

        const updateData = {
            text_count: currentCount,
            push_name: senderName || user.push_name,
            level: newLevel
        }

        await supabase
            .from('users')
            .update(updateData)
            .eq('member_id', cleanId)

        const rewards = []

        if (currentCount % 300 === 0) {
            const rewardAmount = 5000
            const newBal = (user.balance || 0) + rewardAmount
            await supabase.from('users').update({ balance: newBal }).eq('member_id', cleanId)
            rewards.push({ type: 'text_reward', amount: rewardAmount, textCount: currentCount })
        }

        if (leveledUp) {
            const levelReward = newLevel * 1000
            const newBal = (user.balance || 0) + levelReward
            await supabase.from('users').update({ balance: newBal, level: newLevel }).eq('member_id', cleanId)
            rewards.push({ type: 'level_up', amount: levelReward, level: newLevel })
        }

        return { textCount: currentCount, rewards }
    } catch (err) {
        console.error('Exception in incrementTextCount:', err)
        return null
    }
}

export async function getTopN(limit = 20) {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('member_id, push_name, balance')
            .order('balance', { ascending: false })
            .limit(limit)

        if (error || !data) return []
        return data
    } catch (err) {
        console.error('Error in getTopN:', err)
        return []
    }
}

export async function getProfile(memberId) {
    const cleanId = normalizeJid(memberId)
    const user = await getOrCreateUser(cleanId)

    const { data: allUsers } = await supabase
        .from('users')
        .select('member_id, balance')
        .order('balance', { ascending: false })

    let rank = 1
    if (allUsers) {
        const index = allUsers.findIndex((u) => normalizeJid(u.member_id) === cleanId)
        if (index !== -1) rank = index + 1
    }

    return {
        balance: user?.balance || 0,
        rank: rank,
        level: user?.level || 1,
        text_count: user?.text_count || 0,
        stealWins: user?.steal_wins || 0,
        stealLosses: user?.steal_losses || 0
    }
}

export async function claimAirdrop(memberId, groupId) {
    const cleanId = normalizeJid(memberId)
    const user = await getOrCreateUser(cleanId)

    const now = new Date()
    if (user?.last_airdrop) {
        const last = new Date(user.last_airdrop)
        const diffHours = (now - last) / (1000 * 60 * 60)
        if (diffHours < 24) {
            const waitHours = Math.ceil(24 - diffHours)
            return { error: `You must wait ${waitHours} more hours before claiming again.` }
        }
    }

    const amount = 2500
    const newBalance = ((user?.balance) || 0) + amount

    await supabase
        .from('users')
        .update({
            balance: newBalance,
            last_airdrop: now.toISOString()
        })
        .eq('member_id', cleanId)

    return { amount }
}

export async function attemptSteal(stealerId, targetId, groupId) {
    const cleanStealer = normalizeJid(stealerId)
    const cleanTarget = normalizeJid(targetId)

    if (cleanStealer === cleanTarget) {
        return { error: `You cannot steal from yourself!` }
    }

    const stealer = await getOrCreateUser(cleanStealer)
    const target = await getOrCreateUser(cleanTarget)

    if (target?.immunity_until && new Date(target.immunity_until) > new Date()) {
        return { error: `That user has active immunity!` }
    }

    if (((target?.balance) || 0) < 500) {
        return { error: `Target is too broke to steal from.` }
    }

    const success = Math.random() < 0.45
    const stealerBal = stealer?.balance || 0
    const targetBal = target?.balance || 0

    if (success) {
        const movedAmount = Math.floor(targetBal * (Math.random() * 0.25 + 0.10))
        await supabase
            .from('users')
            .update({ balance: stealerBal + movedAmount, steal_wins: (stealer?.steal_wins || 0) + 1 })
            .eq('member_id', cleanStealer)

        await supabase
            .from('users')
            .update({ balance: targetBal - movedAmount })
            .eq('member_id', cleanTarget)

        return { success: true, movedAmount }
    } else {
        const movedAmount = Math.floor(stealerBal * 0.15)
        await supabase
            .from('users')
            .update({ balance: Math.max(0, stealerBal - movedAmount), steal_losses: (stealer?.steal_losses || 0) + 1 })
            .eq('member_id', cleanStealer)

        await supabase
            .from('users')
            .update({ balance: targetBal + movedAmount })
            .eq('member_id', cleanTarget)

        return { success: false, movedAmount }
    }
}

export async function giveMoney(senderId, recipientId, amount, groupId) {
    const cleanSender = normalizeJid(senderId)
    const cleanRecipient = normalizeJid(recipientId)

    if (cleanSender === cleanRecipient) {
        return { error: `You cannot give money to yourself!` }
    }

    if (isNaN(amount) || amount <= 0) {
        return { error: `Please enter a valid amount.` }
    }

    const sender = await getOrCreateUser(cleanSender)
    const recipient = await getOrCreateUser(cleanRecipient)

    if (((sender?.balance) || 0) < amount) {
        return { error: `You do not have enough Habz to give!` }
    }

    const fee = Math.floor(amount * 0.05)
    const amountReceived = amount - fee

    await supabase
        .from('users')
        .update({ balance: (sender?.balance || 0) - amount })
        .eq('member_id', cleanSender)

    await supabase
        .from('users')
        .update({ balance: (recipient?.balance || 0) + amountReceived })
        .eq('member_id', cleanRecipient)

    return { amountReceived, fee }
}

export async function buyImmunity(memberId, hours, groupId) {
    const cleanId = normalizeJid(memberId)
    if (isNaN(hours) || hours <= 0 || hours > 72) {
        return { error: `Please specify hours between 1 and 72.` }
    }

    const user = await getOrCreateUser(cleanId)
    const cost = hours * 2000

    if (((user?.balance) || 0) < cost) {
        return { error: `You need ${cost} Habz for ${hours}h of immunity.` }
    }

    const expiry = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

    await supabase
        .from('users')
        .update({
            balance: (user?.balance || 0) - cost,
            immunity_until: expiry
        })
        .eq('member_id', cleanId)

    return { success: true, cost, hours }
}

export async function proposeMarriage(senderId, targetId) {
    const cleanSender = normalizeJid(senderId)
    const cleanTarget = normalizeJid(targetId)

    if (cleanSender === cleanTarget) return { error: `You can't marry yourself!` }

    const sender = await getOrCreateUser(cleanSender)
    const target = await getOrCreateUser(cleanTarget)

    if (sender?.spouse_id) return { error: `You are already married!` }
    if (target?.spouse_id) return { error: `That person is already married!` }

    await supabase
        .from('marriages')
        .upsert([{ proposer_id: cleanSender, target_id: cleanTarget, status: 'pending' }], { onConflict: 'proposer_id' })

    return { success: true }
}

export async function acceptMarriage(senderId) {
    const cleanSender = normalizeJid(senderId)
    const user = await getOrCreateUser(cleanSender)
    if (user?.spouse_id) return { error: `You are already married!` }

    const { data: proposal } = await supabase
        .from('marriages')
        .select('*')
        .eq('target_id', cleanSender)
        .eq('status', 'pending')
        .maybeSingle()

    if (!proposal) return { error: `You have no pending marriage proposals!` }

    const cleanProposer = proposal.proposer_id

    await supabase.from('users').update({ spouse_id: cleanProposer }).eq('member_id', cleanSender)
    await supabase.from('users').update({ spouse_id: cleanSender }).eq('member_id', cleanProposer)
    await supabase.from('marriages').update({ status: 'accepted' }).eq('id', proposal.id)

    return { success: true, spouseId: cleanProposer }
}

export async function divorce(senderId) {
    const cleanSender = normalizeJid(senderId)
    const user = await getOrCreateUser(cleanSender)
    if (!user?.spouse_id) return { error: `You are not married!` }

    const spouseId = user.spouse_id
    const spouse = await getOrCreateUser(spouseId)

    const totalVault = ((user?.vault_balance) || 0) + ((spouse?.vault_balance) || 0)
    const splitAmount = Math.floor(totalVault / 2)

    await supabase
        .from('users')
        .update({ spouse_id: null, vault_balance: 0, balance: ((user?.balance) || 0) + splitAmount })
        .eq('member_id', cleanSender)

    await supabase
        .from('users')
        .update({ spouse_id: null, vault_balance: 0, balance: ((spouse?.balance) || 0) + splitAmount })
        .eq('member_id', spouseId)

    return { success: true, splitAmount }
}

export async function depositToVault(senderId, amount) {
    const cleanSender = normalizeJid(senderId)
    if (isNaN(amount) || amount <= 0) return { error: `Enter a valid deposit amount.` }

    const user = await getOrCreateUser(cleanSender)
    if (!user?.spouse_id) return { error: `You must be married to use a vault!` }
    if (((user?.balance) || 0) < amount) return { error: `You don't have enough Habz!` }

    await supabase
        .from('users')
        .update({
            balance: (user?.balance || 0) - amount,
            vault_balance: (user?.vault_balance || 0) + amount
        })
        .eq('member_id', cleanSender)

    return { success: true }
}

export async function getVault(senderId) {
    const cleanSender = normalizeJid(senderId)
    const user = await getOrCreateUser(cleanSender)
    if (!user?.spouse_id) return { error: `You are not married!` }

    const spouse = await getOrCreateUser(user.spouse_id)
    const total = ((user?.vault_balance) || 0) + ((spouse?.vault_balance) || 0)

    return { vaultBalance: total }
}

export async function coinflip(senderId, amount, groupId) {
    const cleanSender = normalizeJid(senderId)
    if (isNaN(amount) || amount <= 0) return { error: `Enter a valid bet amount.` }

    const user = await getOrCreateUser(cleanSender)
    if (((user?.balance) || 0) < amount) return { error: `You don't have enough Habz!` }

    const won = Math.random() < 0.48
    const newBal = won ? (user.balance || 0) + amount : (user.balance || 0) - amount

    await supabase.from('users').update({ balance: Math.max(0, newBal) }).eq('member_id', cleanSender)

    return { won, amount }
            }
        
