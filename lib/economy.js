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

// ---------- LOAN ----------
const LOAN_MAX = 100000
const LOAN_COOLDOWN_MS = 24 * 60 * 60 * 1000

// ---------- STRIP ----------
const STRIP_SUCCESS_CHANCE = 0.10
const STRIP_TARGET_WINDOW_MS = 60 * 60 * 1000
const STRIP_TARGET_MAX_HITS = 5

// ---------- SPY ----------
const SPY_COST = 5000

// ---------- SHOP ----------
// Deliberately small/flat catalog — one-time items are a boolean-ish "owned"
// flag (quantity just stays 1), ammo is the only real stockpile-able consumable.
// Priced high on purpose: these are meant to be end-game flexes, not something
// grinded out day one.
const SHOP_ITEMS = {
    ammo: { key: 'ammo', name: 'Ammo', emoji: '🔫', price: 400000, consumable: true, description: 'Consumable — +15% success on your next .rob. One use per unit.' },
    car: { key: 'car', name: 'Car', emoji: '🚗', price: 1500000, consumable: false, description: 'One-time — required to lead a .rob heist.' },
    house: { key: 'house', name: 'House', emoji: '🏠', price: 5000000, consumable: false, description: 'One-time — adds +15,000 habz to every .daily claim.' }
}
const AMMO_ROB_BONUS = 0.15
const HOUSE_DAILY_BONUS = 15000

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

    const hasHouse = await hasItem(memberId, 'house')
    const grossReward = DAILY_REWARD + (hasHouse ? HOUSE_DAILY_BONUS : 0)

    const { repaid, credited, loanBalanceRemaining } = applyLoanRepayment(user, grossReward)

    await updateUser(memberId, {
        balance: Number(user.balance || 0) + credited,
        loan_balance: loanBalanceRemaining,
        last_airdrop: new Date().toISOString()
    })

    return { amount: grossReward, repaid, credited, houseBonus: hasHouse ? HOUSE_DAILY_BONUS : 0 }
}

// ---------- LOAN ----------

// Pure helper (no DB call) — given a user row and a gross amount they just earned,
// figures out how much goes to paying off any outstanding loan_balance first and
// how much actually lands in their balance. Callers are responsible for persisting
// the returned values.
function applyLoanRepayment(user, grossAmount) {
    const owed = Number(user.loan_balance || 0)
    if (owed <= 0) return { repaid: 0, credited: grossAmount, loanBalanceRemaining: 0 }

    const repaid = Math.min(owed, grossAmount)
    return {
        repaid,
        credited: grossAmount - repaid,
        loanBalanceRemaining: owed - repaid
    }
}

// Called from messageHandler right after a level-up payout has already landed
// (the +100,000 is credited inside the increment_text_count RPC itself, since
// that's the hot path). This claws back whatever's owed against that fresh
// credit rather than re-deriving the payout — same net effect as if the loan
// had been deducted before the money ever arrived.
export async function repayLoanFromLevelUp(memberId, grossAmount) {
    const user = await getOrCreateUser(memberId)
    const owed = Number(user.loan_balance || 0)
    if (owed <= 0) return { repaid: 0 }

    const repaid = Math.min(owed, grossAmount)
    await updateUser(memberId, {
        balance: Number(user.balance || 0) - repaid,
        loan_balance: owed - repaid
    })
    return { repaid, loanBalanceRemaining: owed - repaid }
}

export async function takeLoan(memberId, amount, pushName) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }
    if (amount > LOAN_MAX) return { error: `Max loan is ${LOAN_MAX.toLocaleString()} habz.` }

    const user = await getOrCreateUser(memberId, pushName)

    if (user.last_loan_at) {
        const elapsed = Date.now() - new Date(user.last_loan_at).getTime()
        if (elapsed < LOAN_COOLDOWN_MS) {
            const remainingMs = LOAN_COOLDOWN_MS - elapsed
            const hours = Math.floor(remainingMs / (60 * 60 * 1000))
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000))
            return { error: `Already took a loan. Come back in ${hours}h ${minutes}m.` }
        }
    }

    const newLoanBalance = Number(user.loan_balance || 0) + amount

    await updateUser(memberId, {
        balance: Number(user.balance || 0) + amount,
        loan_balance: newLoanBalance,
        last_loan_at: new Date().toISOString()
    })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        amount,
        tx_type: 'loan',
        description: `Total owed: ${newLoanBalance}`
    })

    return { amount, totalOwed: newLoanBalance }
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

export async function grantBonus(targetId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const user = await getOrCreateUser(targetId)
    await updateUser(targetId, { balance: Number(user.balance || 0) + amount })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: targetId,
        amount,
        tx_type: 'bonus',
        description: 'admin-granted bonus'
    })

    return { amount }
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
const ROB_TARGET_WINDOW_MS = 60 * 60 * 1000
const ROB_TARGET_MAX_HITS = 5

export async function checkRobCooldown(targetId) {
    const windowStart = new Date(Date.now() - ROB_TARGET_WINDOW_MS).toISOString()

    const { data, error } = await supabase
        .from('heists')
        .select('resolved_at')
        .eq('target_id', targetId)
        .gte('resolved_at', windowStart)
        .order('resolved_at', { ascending: true })

    if (error) {
        console.error('Error checking rob cooldown:', error.message)
        return { onCooldown: false }
    }

    const hits = data || []
    if (hits.length < ROB_TARGET_MAX_HITS) return { onCooldown: false }

    // Once the oldest of the last 5 hits ages out of the window, a new slot opens up.
    const oldest = new Date(hits[0].resolved_at).getTime()
    const remainingMs = ROB_TARGET_WINDOW_MS - (Date.now() - oldest)
    const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
    return { onCooldown: true, minutes }
}

export async function resolveHeist(groupId, targetId, initiatorId, crewIds, ammoBonus = 0) {
    const success = Math.random() < (ROB_SUCCESS_CHANCE + ammoBonus)

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

export async function withdrawFromVault(memberId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }
    if (Number(marriage.vault_balance || 0) < amount) return { error: "The vault doesn't have that much." }

    const user = await getOrCreateUser(memberId)

    const { error } = await supabase
        .from('marriages')
        .update({ vault_balance: Number(marriage.vault_balance || 0) - amount })
        .eq('id', marriage.id)

    if (error) {
        console.error('Error withdrawing from vault:', error.message)
        return { error: 'Something broke withdrawing that.' }
    }

    await updateUser(memberId, { balance: Number(user.balance || 0) + amount })

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

// ---------- STRIP ----------
// 10% chance, no money moves — a successful hit just cancels the target's
// active steal immunity. Rate-limited per target (not per actor): once a
// target's been hit 5 times in an hour by anyone, they're safe for the rest
// of that window.

export async function attemptStrip(actorId, targetId, groupId, pushName) {
    if (actorId === targetId) return { error: "You can't strip your own immunity." }

    const windowStart = new Date(Date.now() - STRIP_TARGET_WINDOW_MS).toISOString()
    const { data: recentHits, error: countError } = await supabase
        .from('strip_attempts')
        .select('attempted_at')
        .eq('target_id', targetId)
        .gte('attempted_at', windowStart)
        .order('attempted_at', { ascending: true })

    if (countError) {
        console.error('Error checking strip rate limit:', countError.message)
        return { error: 'Something broke checking that.' }
    }

    if ((recentHits || []).length >= STRIP_TARGET_MAX_HITS) {
        const oldest = new Date(recentHits[0].attempted_at).getTime()
        const remainingMs = STRIP_TARGET_WINDOW_MS - (Date.now() - oldest)
        const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
        return { error: `They've been stripped enough this hour. Try again in ${minutes}m.` }
    }

    const target = await getOrCreateUser(targetId, undefined)
    await getOrCreateUser(actorId, pushName)

    const success = Math.random() < STRIP_SUCCESS_CHANCE
    const hadImmunity = Boolean(target.immunity_until && new Date(target.immunity_until).getTime() > Date.now())

    if (success && hadImmunity) {
        await updateUser(targetId, { immunity_until: null })
    }

    await supabase.from('strip_attempts').insert({
        actor_id: actorId,
        target_id: targetId,
        group_id: groupId,
        success
    })

    return { success, hadImmunity, removedImmunity: success && hadImmunity }
}

// ---------- SPY ----------

export async function spyOnUser(actorId, targetId, pushName) {
    if (actorId === targetId) return { error: 'Just check `.profile`.' }

    const actor = await getOrCreateUser(actorId, pushName)
    if (Number(actor.balance || 0) < SPY_COST) return { error: `You need ${SPY_COST.toLocaleString()} habz for that.` }

    const target = await getOrCreateUser(targetId)
    const profile = await getProfile(targetId)

    await updateUser(actorId, { balance: Number(actor.balance || 0) - SPY_COST })

    const immunityActive = Boolean(target.immunity_until && new Date(target.immunity_until).getTime() > Date.now())
    const immunityMinutesLeft = immunityActive
        ? Math.ceil((new Date(target.immunity_until).getTime() - Date.now()) / (60 * 1000))
        : 0

    return {
        cost: SPY_COST,
        balance: profile.balance,
        level: profile.level,
        rank: profile.rank,
        stealWins: profile.stealWins,
        stealLosses: profile.stealLosses,
        loanBalance: Number(target.loan_balance || 0),
        immunityActive,
        immunityMinutesLeft
    }
}

// ---------- SHOP / INVENTORY ----------

export function getShopListing() {
    return Object.values(SHOP_ITEMS)
}

export async function getInventory(memberId) {
    const { data, error } = await supabase
        .from('user_inventory')
        .select('item_key, quantity')
        .eq('member_id', memberId)
        .gt('quantity', 0)

    if (error) {
        console.error('Error fetching inventory:', error.message)
        return []
    }

    return (data || []).map((row) => ({
        ...SHOP_ITEMS[row.item_key],
        quantity: row.quantity
    })).filter((item) => item.key)
}

export async function hasItem(memberId, itemKey) {
    const { data, error } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', itemKey)
        .maybeSingle()

    if (error) {
        console.error('Error checking inventory item:', error.message)
        return false
    }
    return Boolean(data && data.quantity > 0)
}

// Consumes one unit of a consumable item (currently just ammo). Returns
// whether a unit was actually available and got used.
export async function consumeItem(memberId, itemKey) {
    const { data, error } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', itemKey)
        .maybeSingle()

    if (error || !data || data.quantity <= 0) return false

    await supabase
        .from('user_inventory')
        .update({ quantity: data.quantity - 1, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)
        .eq('item_key', itemKey)

    return true
}

export async function buyShopItem(memberId, itemKey, pushName) {
    const item = SHOP_ITEMS[itemKey]
    if (!item) return { error: `No such item. Try \`.shop\` to see what's on sale.` }

    if (!item.consumable) {
        const alreadyOwned = await hasItem(memberId, itemKey)
        if (alreadyOwned) return { error: `You already own a ${item.name.toLowerCase()}.` }
    }

    const user = await getOrCreateUser(memberId, pushName)
    if (Number(user.balance || 0) < item.price) {
        return { error: `You need ${item.price.toLocaleString()} habz for a ${item.name.toLowerCase()}. You're nowhere close.` }
    }

    await updateUser(memberId, { balance: Number(user.balance || 0) - item.price })

    const { data: existing } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', itemKey)
        .maybeSingle()

    if (existing) {
        await supabase
            .from('user_inventory')
            .update({ quantity: existing.quantity + 1, updated_at: new Date().toISOString() })
            .eq('member_id', memberId)
            .eq('item_key', itemKey)
    } else {
        await supabase
            .from('user_inventory')
            .insert({ member_id: memberId, item_key: itemKey, quantity: 1 })
    }

    await supabase.from('transactions').insert({
        sender_id: memberId,
        receiver_id: null,
        amount: item.price,
        tx_type: 'shop',
        description: `Bought: ${item.name}`
    })

    return { item }
}
