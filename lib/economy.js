import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
)

const MESSAGES_PER_LEVEL = 50
const LEVEL_REWARD = 100000

export async function getOrCreateUser(memberId, pushName = null) {
    const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('member_id', memberId)
        .maybeSingle()

    if (existing) {
        if (pushName && pushName !== existing.push_name) {
            await supabase.from('users').update({ push_name: pushName }).eq('member_id', memberId)
            return { ...existing, push_name: pushName }
        }
        return existing
    }

    const { data: created } = await supabase
        .from('users')
        .insert({ member_id: memberId, push_name: pushName })
        .select()
        .maybeSingle()

    return created
}

export async function ensureGroupExists(groupId, groupName) {
    await supabase
        .from('groups')
        .upsert({ group_id: groupId, group_name: groupName }, { onConflict: 'group_id', ignoreDuplicates: true })
}

export async function ensureGroupMembership(memberId, groupId) {
    await supabase
        .from('group_members')
        .upsert({ member_id: memberId, group_id: groupId }, { onConflict: 'member_id,group_id', ignoreDuplicates: true })
}

async function logTransaction(senderId, receiverId, groupId, amount, txType, description) {
    await supabase.from('transactions').insert({
        sender_id: senderId,
        receiver_id: receiverId,
        group_id: groupId,
        amount,
        tx_type: txType,
        description
    })
}

export async function incrementTextCount(memberId, groupId, pushName = null) {
    const user = await getOrCreateUser(memberId, pushName)
    const newTextCount = user.text_count + 1
    const newWeeklyTextCount = (user.weekly_text_count || 0) + 1

    const rewards = []
    let balanceIncrease = 0

    const previousRewardTier = Math.floor(user.text_count / 300)
    const newRewardTier = Math.floor(newTextCount / 300)
    if (newRewardTier > previousRewardTier) {
        const tiersGained = newRewardTier - previousRewardTier
        const rewardAmount = tiersGained * 2000
        balanceIncrease += rewardAmount
        rewards.push({ type: 'text_reward', amount: rewardAmount, textCount: newTextCount })
    }

    const previousLevel = Math.floor(user.text_count / MESSAGES_PER_LEVEL)
    const newLevel = Math.floor(newTextCount / MESSAGES_PER_LEVEL)
    if (newLevel > previousLevel) {
        const levelsGained = newLevel - previousLevel
        const levelReward = levelsGained * LEVEL_REWARD
        balanceIncrease += levelReward
        rewards.push({ type: 'level_up', level: newLevel, amount: levelReward })
    }

    const newBalance = user.balance + balanceIncrease

    await supabase
        .from('users')
        .update({
            text_count: newTextCount,
            weekly_text_count: newWeeklyTextCount,
            balance: newBalance,
            level: newLevel,
            updated_at: new Date().toISOString()
        })
        .eq('member_id', memberId)

    if (balanceIncrease > 0) {
        await logTransaction(null, memberId, groupId, balanceIncrease, 'reward', 'Text count rewards')
    }

    return { rewards, newBalance, newLevel }
}

export function hasImmunity(user) {
    return Boolean(user.immunity_until && new Date(user.immunity_until) > new Date())
}

export async function attemptSteal(stealerId, targetId, groupId) {
    if (stealerId === targetId) {
        return { error: 'You cannot steal from yourself.' }
    }

    const stealer = await getOrCreateUser(stealerId)
    const target = await getOrCreateUser(targetId)

    if (hasImmunity(target)) {
        return { error: 'This user has immunity right now.' }
    }

    if (stealer.last_steal_time) {
        const cooldownEnds = new Date(stealer.last_steal_time).getTime() + 30 * 60 * 1000
        if (Date.now() < cooldownEnds) {
            const minutesLeft = Math.ceil((cooldownEnds - Date.now()) / 60000)
            return { error: `Wait ${minutesLeft} more minute(s) before stealing again.` }
        }
    }

    const targets24h = stealer.steal_targets_24h || []
    const targetCount = targets24h.filter((id) => id === targetId).length
    if (targetCount >= 5) {
        return { error: 'User targeted much today, try again tomorrow' }
    }

    const success = Math.random() < 0.3
    const movedAmount = success ? target.balance : Math.floor(stealer.balance * 0.8)

    const newStealerBalance = success ? stealer.balance + movedAmount : stealer.balance - movedAmount
    const newTargetBalance = success ? target.balance - movedAmount : target.balance + movedAmount

    await supabase
        .from('users')
        .update({
            balance: newStealerBalance,
            last_steal_time: new Date().toISOString(),
            steal_targets_24h: [...targets24h, targetId],
            updated_at: new Date().toISOString()
        })
        .eq('member_id', stealerId)

    await supabase
        .from('users')
        .update({ balance: newTargetBalance, updated_at: new Date().toISOString() })
        .eq('member_id', targetId)

    await supabase.from('steal_attempts').insert({
        stealer_id: stealerId,
        target_id: targetId,
        group_id: groupId,
        amount: movedAmount,
        success
    })

    return { success, movedAmount, newStealerBalance, newTargetBalance }
}

export async function giveMoney(giverId, receiverId, amount, groupId) {
    if (!receiverId) {
        return { error: 'You must reply to a user to give money to them.' }
    }
    if (giverId === receiverId) {
        return { error: 'You cannot give money to yourself.' }
    }
    if (!amount || amount <= 0 || Number.isNaN(amount)) {
        return { error: 'Enter a valid amount.' }
    }

    const giver = await getOrCreateUser(giverId)
    const receiver = await getOrCreateUser(receiverId)

    if (giver.balance < amount) {
        return { error: 'Insufficient balance for this transfer.' }
    }

    const fee = Math.ceil(amount * 0.05)
    const amountReceived = amount - fee

    const newGiverBalance = giver.balance - amount
    const newReceiverBalance = receiver.balance + amountReceived

    await supabase
        .from('users')
        .update({ balance: newGiverBalance, updated_at: new Date().toISOString() })
        .eq('member_id', giverId)

    await supabase
        .from('users')
        .update({ balance: newReceiverBalance, updated_at: new Date().toISOString() })
        .eq('member_id', receiverId)

    await logTransaction(giverId, receiverId, groupId, amount, 'give', `Fee: ${fee}, received: ${amountReceived}`)

    return { newGiverBalance, newReceiverBalance, fee, amountReceived }
}

export async function claimAirdrop(memberId, groupId) {
    const { data: airdrop, error } = await supabase
        .from('airdrops')
        .select('*')
        .eq('group_id', groupId)
        .eq('is_claimed', false)
        .order('dropped_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error || !airdrop) {
        return { error: 'No active airdrop right now.' }
    }

    const { data: updated } = await supabase
        .from('airdrops')
        .update({ is_claimed: true, claimed_by: memberId, claimed_at: new Date().toISOString() })
        .eq('id', airdrop.id)
        .eq('is_claimed', false)
        .select()
        .maybeSingle()

    if (!updated) {
        return { error: 'Someone already claimed this airdrop.' }
    }

    const user = await getOrCreateUser(memberId)
    const newBalance = user.balance + airdrop.amount

    await supabase
        .from('users')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    await logTransaction(null, memberId, groupId, airdrop.amount, 'airdrop', 'Airdrop claim')

    return { amount: airdrop.amount, newBalance }
}

export async function getTopN(n = 20) {
    const { data } = await supabase
        .from('users')
        .select('member_id, push_name, balance, level')
        .order('balance', { ascending: false })
        .limit(n)

    return data || []
}

export async function getProfile(memberId) {
    const user = await getOrCreateUser(memberId)

    const { count: higherBalanceCount } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .gt('balance', user.balance)

    const { count: wins } = await supabase
        .from('steal_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('stealer_id', memberId)
        .eq('success', true)

    const { count: losses } = await supabase
        .from('steal_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('stealer_id', memberId)
        .eq('success', false)

    return {
        ...user,
        rank: (higherBalanceCount || 0) + 1,
        stealWins: wins || 0,
        stealLosses: losses || 0
    }
}

export async function buyImmunity(memberId, hours, groupId) {
    if (!hours || hours <= 0 || Number.isNaN(hours)) {
        return { error: 'Enter a valid number of hours.' }
    }

    const user = await getOrCreateUser(memberId)
    const cost = hours * 10000

    if (user.balance < cost) {
        return { error: 'Insufficient balance for that much immunity.' }
    }

    const currentExpiry = hasImmunity(user) ? new Date(user.immunity_until) : new Date()
    const newExpiry = new Date(currentExpiry.getTime() + hours * 60 * 60 * 1000)
    const newBalance = user.balance - cost

    await supabase
        .from('users')
        .update({
            balance: newBalance,
            immunity_until: newExpiry.toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('member_id', memberId)

    await logTransaction(memberId, null, groupId, cost, 'immunity_purchase', `${hours}h immunity`)

    return { newBalance, immunityUntil: newExpiry }
}

export async function coinflip(memberId, amount, groupId) {
    if (!amount || amount <= 0 || Number.isNaN(amount)) {
        return { error: 'Enter a valid amount.' }
    }

    const user = await getOrCreateUser(memberId)

    if (user.balance < amount) {
        return { error: 'Insufficient balance for that wager.' }
    }

    const won = Math.random() < 0.5
    const newBalance = won ? user.balance + amount : user.balance - amount

    await supabase
        .from('users')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    await logTransaction(
        memberId,
        null,
        groupId,
        amount,
        won ? 'coinflip_win' : 'coinflip_loss',
        `Coinflip ${won ? 'win' : 'loss'}`
    )

    return { won, newBalance, amount }
}

async function getActiveMarriage(memberId) {
    const { data } = await supabase
        .from('marriages')
        .select('*')
        .or(`partner1_id.eq.${memberId},partner2_id.eq.${memberId}`)
        .in('status', ['pending', 'married'])
        .maybeSingle()

    return data
}

export async function proposeMarriage(proposerId, targetId) {
    if (!targetId) {
        return { error: 'You must reply to the person you want to marry.' }
    }
    if (proposerId === targetId) {
        return { error: 'You cannot marry yourself.' }
    }

    const existingProposer = await getActiveMarriage(proposerId)
    if (existingProposer) {
        return { error: 'You are already married or have a pending proposal.' }
    }

    const existingTarget = await getActiveMarriage(targetId)
    if (existingTarget) {
        return { error: 'That user is already married or has a pending proposal.' }
    }

    await supabase.from('marriages').insert({
        partner1_id: proposerId,
        partner2_id: targetId,
        status: 'pending',
        proposed_by: proposerId
    })

    return { success: true }
}

export async function acceptMarriage(accepterId) {
    const { data: pending } = await supabase
        .from('marriages')
        .select('*')
        .eq('partner2_id', accepterId)
        .eq('status', 'pending')
        .maybeSingle()

    if (!pending) {
        return { error: 'No pending marriage proposal for you.' }
    }

    await supabase
        .from('marriages')
        .update({ status: 'married', married_at: new Date().toISOString() })
        .eq('id', pending.id)

    return { success: true, partnerId: pending.partner1_id }
}

export async function divorce(memberId) {
    const marriage = await getActiveMarriage(memberId)

    if (!marriage || marriage.status !== 'married') {
        return { error: 'You are not currently married.' }
    }

    const half = Math.floor(marriage.vault_balance / 2)
    const remainder = marriage.vault_balance - half * 2

    const partner1 = await getOrCreateUser(marriage.partner1_id)
    const partner2 = await getOrCreateUser(marriage.partner2_id)

    await supabase
        .from('users')
        .update({ balance: partner1.balance + half + remainder, updated_at: new Date().toISOString() })
        .eq('member_id', marriage.partner1_id)

    await supabase
        .from('users')
        .update({ balance: partner2.balance + half, updated_at: new Date().toISOString() })
        .eq('member_id', marriage.partner2_id)

    await supabase
        .from('marriages')
        .update({ status: 'divorced', divorced_at: new Date().toISOString(), vault_balance: 0 })
        .eq('id', marriage.id)

    return { success: true, splitAmount: half }
}

export async function depositToVault(memberId, amount) {
    if (!amount || amount <= 0 || Number.isNaN(amount)) {
        return { error: 'Enter a valid amount.' }
    }

    const marriage = await getActiveMarriage(memberId)
    if (!marriage || marriage.status !== 'married') {
        return { error: 'You are not currently married.' }
    }

    const user = await getOrCreateUser(memberId)
    if (user.balance < amount) {
        return { error: 'Insufficient balance.' }
    }

    const newVaultBalance = marriage.vault_balance + amount

    await supabase
        .from('users')
        .update({ balance: user.balance - amount, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    await supabase.from('marriages').update({ vault_balance: newVaultBalance }).eq('id', marriage.id)

    return { success: true, newVaultBalance }
}

export async function getVault(memberId) {
    const marriage = await getActiveMarriage(memberId)
    if (!marriage || marriage.status !== 'married') {
        return { error: 'You are not currently married.' }
    }

    const partnerId = marriage.partner1_id === memberId ? marriage.partner2_id : marriage.partner1_id
    return { vaultBalance: marriage.vault_balance, partnerId }
}
