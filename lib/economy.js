import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase environment variables are missing! Check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

const STARTING_BALANCE = 1000
const LEVEL_UP_MESSAGE_INTERVAL = 50
const LEVEL_UP_REWARD = 100000
const DAILY_REWARD = 25000
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000
const STEAL_WINDOW_MS = 30 * 60 * 1000
const STEAL_MAX_ATTEMPTS = 2
const STEAL_SUCCESS_CHANCE = 0.3
const STEAL_FAIL_LOSS_RATE = 0.9
const GIVE_FEE_RATE = 0.05
const IMMUNITY_COST_PER_HOUR = 2000

// ---------- USER CORE ----------

export async function getOrCreateUser(memberId, pushName = 'User') {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('member_id', memberId)
        .maybeSingle()

    if (error) {
        console.error('Error fetching user:', error.message)
    }

    if (data) return data

    const newUser = {
        member_id: memberId,
        push_name: pushName,
        balance: STARTING_BALANCE,
        text_count: 0,
        level: 1,
        steal_wins: 0,
        steal_losses: 0,
        vault_balance: 0
    }

    const { data: created, error: createError } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .maybeSingle()

    if (createError) {
        // Handle race condition: user got created between our select and insert
        const { data: existing } = await supabase
            .from('users')
            .select('*')
            .eq('member_id', memberId)
            .maybeSingle()
        if (existing) return existing
        console.error('Error creating user:', createError.message)
        return newUser
    }

    return created
}

export async function updateUser(memberId, updates) {
    const { data, error } = await supabase
        .from('users')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)
        .select()
        .maybeSingle()

    if (error) {
        console.error('Error updating user:', error.message)
    }
    return data
}

// Called on every group message. One atomic round trip (via the increment_text_count
// Postgres function) instead of ~5-6 sequential calls — this is the hot path that runs
// on every single message, so it matters a lot under load.
export async function incrementTextCount(memberId, groupId, pushName, groupName) {
    const { data, error } = await supabase.rpc('increment_text_count', {
        p_member_id: memberId,
        p_group_id: groupId,
        p_push_name: pushName,
        p_group_name: groupName || null
    })

    if (error) {
        console.error('Error incrementing text count:', error.message)
        return { leveledUp: false, newLevel: 1, textCount: 0 }
    }

    const row = Array.isArray(data) ? data[0] : data
    return {
        leveledUp: Boolean(row?.leveled_up),
        newLevel: row?.new_level ?? 1,
        textCount: row?.new_text_count ?? 0
    }
}

export async function getTopN(n = 20) {
    const { data, error } = await supabase
        .from('users')
        .select('member_id, push_name, balance, level')
        .order('balance', { ascending: false })
        .limit(n)

    if (error) {
        console.error('Error fetching leaderboard:', error.message)
        return []
    }
    return data || []
}

export async function getProfile(memberId) {
    const user = await getOrCreateUser(memberId)

    const { count: rankCount } = await supabase
        .from('users')
        .select('member_id', { count: 'exact', head: true })
        .gt('balance', user.balance || 0)

    const marriage = await getActiveMarriage(memberId)
    const spouseId = marriage ? (marriage.partner1_id === memberId ? marriage.partner2_id : marriage.partner1_id) : null

    return {
        balance: Number(user.balance || 0),
        rank: (rankCount || 0) + 1,
        level: user.level || 1,
        text_count: user.text_count || 0,
        stealWins: user.steal_wins || 0,
        stealLosses: user.steal_losses || 0,
        vaultBalance: marriage ? Number(marriage.vault_balance || 0) : 0,
        spouseId
    }
}

// ---------- DAILY ----------

export async function claimDaily(memberId, pushName) {
    const user = await getOrCreateUser(memberId, pushName)

    if (user.last_airdrop) {
        const elapsed = Date.now() - new Date(user.last_airdrop).getTime()
        if (elapsed < DAILY_COOLDOWN_MS) {
            const remainingMs = DAILY_COOLDOWN_MS - elapsed
            const hours = Math.floor(remainingMs / (60 * 60 * 1000))
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000))
            return { error: `Already claimed. Come back in ${hours}h ${minutes}m.` }
        }
    }

    const newBalance = Number(user.balance || 0) + DAILY_REWARD
    await updateUser(memberId, { balance: newBalance, last_airdrop: new Date().toISOString() })

    return { amount: DAILY_REWARD }
}

// ---------- ADMIN: GIVE-ALL & ONE-TIME TAX ----------

export async function giveAllMembers(groupId, amount) {
    if (!groupId) return { error: 'No group to drop this in.' }
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const { data, error } = await supabase.rpc('give_all_members', {
        p_group_id: groupId,
        p_amount: amount
    })

    if (error) {
        console.error('Error running give-all:', error.message)
        return { error: 'Something broke handing out money.' }
    }

    return { affectedCount: data ?? 0, amount }
}

export async function taxAllMembers(groupId, percent) {
    if (!groupId) return { error: 'No group to tax.' }
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return { error: 'Enter a percent between 1 and 100.' }

    const { data, error } = await supabase.rpc('tax_all_members', {
        p_group_id: groupId,
        p_percent: percent
    })

    if (error) {
        console.error('Error running tax:', error.message)
        return { error: 'Something broke collecting that tax.' }
    }

    const row = Array.isArray(data) ? data[0] : data
    return { affectedCount: row?.affected_count ?? 0, totalCollected: Number(row?.total_collected ?? 0), percent }
}

// ---------- GROUP AIRDROP (admin-triggered, first .claim wins) ----------

const AIRDROP_MIN = 50000
const AIRDROP_MAX = 150000

export async function createGroupAirdrop(groupId) {
    if (!groupId) return { error: 'No group to drop this in.' }

    // Rounded to the nearest 1,000 for a cleaner-looking announcement.
    const amount = Math.round((Math.random() * (AIRDROP_MAX - AIRDROP_MIN) + AIRDROP_MIN) / 1000) * 1000

    const { error } = await supabase.from('airdrops').insert({
        group_id: groupId,
        amount,
        is_claimed: false,
        dropped_at: new Date().toISOString()
    })

    if (error) {
        console.error('Error creating airdrop:', error.message)
        return { error: 'Something broke dropping that airdrop.' }
    }

    return { amount }
}

export async function claimGroupAirdrop(memberId, groupId, pushName) {
    if (!groupId) return { error: 'No airdrop to claim here.' }

    const { data: airdrop, error } = await supabase
        .from('airdrops')
        .select('*')
        .eq('group_id', groupId)
        .eq('is_claimed', false)
        .order('dropped_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching airdrop:', error.message)
        return { error: 'Something broke checking the airdrop.' }
    }
    if (!airdrop) return { error: 'No active airdrop in this group right now.' }

    const { data: claimed, error: claimError } = await supabase
        .from('airdrops')
        .update({ is_claimed: true, claimed_by: memberId, claimed_at: new Date().toISOString() })
        .eq('id', airdrop.id)
        .eq('is_claimed', false)
        .select()
        .maybeSingle()

    if (claimError || !claimed) {
        return { error: 'Someone already beat you to it.' }
    }

    const user = await getOrCreateUser(memberId, pushName)
    await updateUser(memberId, { balance: Number(user.balance || 0) + Number(claimed.amount) })

    return { amount: Number(claimed.amount) }
}

// ---------- STEAL ----------

export async function attemptSteal(stealerId, targetId, groupId, pushName) {
    if (stealerId === targetId) return { error: "You can't steal from yourself." }

    const stealer = await getOrCreateUser(stealerId, pushName)
    const target = await getOrCreateUser(targetId)

    if (target.immunity_until && new Date(target.immunity_until).getTime() > Date.now()) {
        return { error: 'Target has immunity right now. Try someone else.' }
    }

    let attemptsUsed = stealer.steal_count_24h || 0
    if (!stealer.last_steal_time || Date.now() - new Date(stealer.last_steal_time).getTime() > STEAL_WINDOW_MS) {
        attemptsUsed = 0
    }

    if (attemptsUsed >= STEAL_MAX_ATTEMPTS) {
        const elapsed = Date.now() - new Date(stealer.last_steal_time).getTime()
        const remainingMs = STEAL_WINDOW_MS - elapsed
        const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
        return { error: `You're out of steal attempts. Try again in ${minutes}m.` }
    }

    const success = Math.random() < STEAL_SUCCESS_CHANCE
    let movedAmount = 0

    if (success) {
        movedAmount = Number(target.balance || 0)
        await updateUser(targetId, { balance: 0 })
        await updateUser(stealerId, {
            balance: Number(stealer.balance || 0) + movedAmount,
            steal_wins: (stealer.steal_wins || 0) + 1,
            steal_count_24h: attemptsUsed + 1,
            last_steal_time: new Date().toISOString()
        })
    } else {
        movedAmount = Math.floor(Number(stealer.balance || 0) * STEAL_FAIL_LOSS_RATE)
        await updateUser(stealerId, {
            balance: Number(stealer.balance || 0) - movedAmount,
            steal_losses: (stealer.steal_losses || 0) + 1,
            steal_count_24h: attemptsUsed + 1,
            last_steal_time: new Date().toISOString()
        })
        await updateUser(targetId, { balance: Number(target.balance || 0) + movedAmount })
    }

    await supabase.from('steal_attempts').insert({
        stealer_id: stealerId,
        target_id: targetId,
        group_id: groupId,
        amount: movedAmount,
        success
    })

    return { success, movedAmount }
}

// ---------- HEIST (.rob) ----------
// Note: the identity of who's on the crew and the 10-second recruiting window
// itself is tracked in-memory in messageHandler.js (it's real-time/transient).
// This file only handles the cooldown check and the atomic payout once a heist
// resolves.

const ROB_SUCCESS_CHANCE = 0.5
const ROB_COOLDOWN_MS = 2 * 60 * 60 * 1000 // global per target, not per group

export async function checkRobCooldown(targetId) {
    const { data, error } = await supabase
        .from('heists')
        .select('resolved_at')
        .eq('target_id', targetId)
        .not('resolved_at', 'is', null)
        .order('resolved_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error checking rob cooldown:', error.message)
        return { onCooldown: false }
    }
    if (!data?.resolved_at) return { onCooldown: false }

    const elapsed = Date.now() - new Date(data.resolved_at).getTime()
    if (elapsed < ROB_COOLDOWN_MS) {
        const minutes = Math.max(1, Math.ceil((ROB_COOLDOWN_MS - elapsed) / (60 * 1000)))
        return { onCooldown: true, minutes }
    }
    return { onCooldown: false }
}

export async function resolveHeist(groupId, targetId, initiatorId, crewIds) {
    const success = Math.random() < ROB_SUCCESS_CHANCE

    const { data, error } = await supabase.rpc('resolve_heist', {
        p_target_id: targetId,
        p_crew_ids: crewIds,
        p_success: success
    })

    if (error) {
        console.error('Error resolving heist:', error.message)
        return { error: 'Something broke resolving the heist.' }
    }

    const row = Array.isArray(data) ? data[0] : data
    const totalMoved = Number(row?.total_moved ?? 0)
    const perMemberShare = Number(row?.per_member_share ?? 0)

    await supabase.from('heists').insert({
        group_id: groupId,
        target_id: targetId,
        initiator_id: initiatorId,
        crew_ids: crewIds,
        success,
        amount_moved: totalMoved,
        resolved_at: new Date().toISOString()
    })

    return { success, totalMoved, perMemberShare, crewSize: crewIds.length }
}

// ---------- GIVE ----------

export async function giveMoney(senderId, targetId, amount, groupId, pushName) {
    if (senderId === targetId) return { error: "You can't send money to yourself." }
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const sender = await getOrCreateUser(senderId, pushName)
    if (Number(sender.balance || 0) < amount) return { error: "You don't have that much." }

    const fee = Math.floor(amount * GIVE_FEE_RATE)
    const amountReceived = amount - fee

    const target = await getOrCreateUser(targetId)

    await updateUser(senderId, { balance: Number(sender.balance || 0) - amount })
    await updateUser(targetId, { balance: Number(target.balance || 0) + amountReceived })

    await supabase.from('transactions').insert({
        sender_id: senderId,
        receiver_id: targetId,
        group_id: groupId,
        amount,
        tx_type: 'give',
        description: `Fee: ${fee}`
    })

    return { amountReceived, fee }
}

// ---------- IMMUNITY ----------

export async function buyImmunity(memberId, hours, groupId, pushName) {
    if (!Number.isInteger(hours) || hours <= 0) return { error: 'Enter a valid number of hours.' }

    const user = await getOrCreateUser(memberId, pushName)
    const cost = hours * IMMUNITY_COST_PER_HOUR

    if (Number(user.balance || 0) < cost) return { error: `You need ${cost.toLocaleString()} habz for that.` }

    const currentImmunity = user.immunity_until && new Date(user.immunity_until).getTime() > Date.now()
        ? new Date(user.immunity_until).getTime()
        : Date.now()

    const newImmunityUntil = new Date(currentImmunity + hours * 60 * 60 * 1000).toISOString()

    await updateUser(memberId, {
        balance: Number(user.balance || 0) - cost,
        immunity_until: newImmunityUntil
    })

    return { hours, cost }
}

// ---------- COINFLIP ----------

export async function coinflip(memberId, amount, groupId, pushName) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const user = await getOrCreateUser(memberId, pushName)
    if (Number(user.balance || 0) < amount) return { error: "You don't have that much to bet." }

    const won = Math.random() < 0.5
    const newBalance = won ? Number(user.balance || 0) + amount : Number(user.balance || 0) - amount

    await updateUser(memberId, { balance: newBalance })

    await supabase.from('transactions').insert({
        sender_id: memberId,
        receiver_id: null,
        group_id: groupId,
        amount,
        tx_type: 'coinflip',
        description: won ? 'win' : 'loss'
    })

    return { won, amount }
}

// ---------- MARRIAGE ----------

async function getActiveMarriage(memberId) {
    const { data, error } = await supabase
        .from('marriages')
        .select('*')
        .or(`partner1_id.eq.${memberId},partner2_id.eq.${memberId}`)
        .eq('status', 'married')
        .maybeSingle()

    if (error) {
        console.error('Error fetching marriage:', error.message)
        return null
    }
    return data
}

async function getAnyActiveOrPendingMarriage(memberId) {
    const { data, error } = await supabase
        .from('marriages')
        .select('*')
        .or(`partner1_id.eq.${memberId},partner2_id.eq.${memberId}`)
        .in('status', ['pending', 'married'])
        .maybeSingle()

    if (error) {
        console.error('Error fetching marriage:', error.message)
        return null
    }
    return data
}

export async function proposeMarriage(proposerId, targetId, pushName) {
    if (proposerId === targetId) return { error: "You can't marry yourself." }

    await getOrCreateUser(proposerId, pushName)
    await getOrCreateUser(targetId)

    const proposerExisting = await getAnyActiveOrPendingMarriage(proposerId)
    if (proposerExisting) {
        return { error: proposerExisting.status === 'married' ? "You're already married." : 'You already have a pending proposal.' }
    }

    const targetExisting = await getAnyActiveOrPendingMarriage(targetId)
    if (targetExisting) {
        return { error: "They're already taken or have a pending proposal." }
    }

    const { error } = await supabase.from('marriages').insert({
        partner1_id: proposerId,
        partner2_id: targetId,
        status: 'pending',
        proposed_by: proposerId
    })

    if (error) {
        console.error('Error creating proposal:', error.message)
        return { error: 'Something broke sending that proposal.' }
    }

    return { success: true }
}

export async function acceptMarriage(accepterId) {
    const { data: proposal, error } = await supabase
        .from('marriages')
        .select('*')
        .eq('partner2_id', accepterId)
        .eq('status', 'pending')
        .order('proposed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching proposal:', error.message)
        return { error: 'Something broke checking your proposals.' }
    }
    if (!proposal) return { error: "You don't have a pending proposal." }

    const { error: updateError } = await supabase
        .from('marriages')
        .update({ status: 'married', married_at: new Date().toISOString() })
        .eq('id', proposal.id)

    if (updateError) {
        console.error('Error accepting marriage:', updateError.message)
        return { error: 'Something broke accepting that proposal.' }
    }

    return { spouseId: proposal.partner1_id }
}

export async function divorce(memberId) {
    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }

    const splitAmount = Math.floor(Number(marriage.vault_balance || 0) / 2)

    if (splitAmount > 0) {
        const partner1 = await getOrCreateUser(marriage.partner1_id)
        const partner2 = await getOrCreateUser(marriage.partner2_id)
        await updateUser(marriage.partner1_id, { balance: Number(partner1.balance || 0) + splitAmount })
        await updateUser(marriage.partner2_id, { balance: Number(partner2.balance || 0) + splitAmount })
    }

    const { error } = await supabase
        .from('marriages')
        .update({ status: 'divorced', divorced_at: new Date().toISOString(), vault_balance: 0 })
        .eq('id', marriage.id)

    if (error) {
        console.error('Error divorcing:', error.message)
        return { error: 'Something broke ending that marriage.' }
    }

    return { splitAmount }
}

export async function getVault(memberId) {
    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }
    return { vaultBalance: Number(marriage.vault_balance || 0) }
}

export async function depositToVault(memberId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }

    const user = await getOrCreateUser(memberId)
    if (Number(user.balance || 0) < amount) return { error: "You don't have that much." }

    await updateUser(memberId, { balance: Number(user.balance || 0) - amount })

    const { error } = await supabase
        .from('marriages')
        .update({ vault_balance: Number(marriage.vault_balance || 0) + amount })
        .eq('id', marriage.id)

    if (error) {
        console.error('Error depositing to vault:', error.message)
        return { error: 'Something broke depositing that.' }
    }

    return { success: true }
}

// Kept for the admin dashboard's leaderboard formatting endpoint
export async function getLeaderboardFormatted() {
    const data = await getTopN(20)

    if (!data || data.length === 0) {
        return '🏆 *HABIBI TOP BALANCES* 🏆\n\nNo records found yet!'
    }

    let text = '🏆 *Top 20 Flexers* 🏆\n\n'
    data.forEach((user, index) => {
        const name = user.push_name || 'Anonymous'
        const bal = Number(user.balance || 0).toLocaleString()
        text += `${index + 1}. *${name}* :\n     *BALANCE* - _₻${bal}_\n\n`
    })

    return text.trim()
}
