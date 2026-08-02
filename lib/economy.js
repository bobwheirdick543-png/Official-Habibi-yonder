import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase environment variables are missing! Check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

export async function getOrCreateUser(userId, pushName = 'Someone') {
    const cleanId = userId.split('@')[0]
    
    let { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', cleanId)
        .single()

    if (!user) {
        const { data: newUser, error: createError } = await supabase
            .from('users')
            .insert([
                {
                    id: cleanId,
                    push_name: pushName,
                    balance: 1000,
                    text_count: 0,
                    level: 1,
                    steal_wins: 0,
                    steal_losses: 0,
                    vault_balance: 0
                }
            ])
            .select()
            .single()

        if (createError) {
            console.error('Error creating user:', createError)
            return { id: cleanId, balance: 1000, text_count: 0, level: 1, steal_wins: 0, steal_losses: 0, vault_balance: 0 }
        }
        return newUser
    }

    return user
}

export async function incrementTextCount(senderId, chatId, pushName) {
    try {
        const user = await getOrCreateUser(senderId, pushName)
        const newTextCount = (user.text_count || 0) + 1
        
        // LEVEL FORMULA: 1 Level for every 50 messages sent
        const currentLevel = user.level || 1
        const newLevel = Math.floor(newTextCount / 50) + 1

        let newBalance = user.balance || 0

        // Grant 100,000 Habz reward upon each level gained
        if (newLevel > currentLevel) {
            const levelDiff = newLevel - currentLevel
            const bonusReward = levelDiff * 100000
            newBalance += bonusReward
        }

        const { error } = await supabase
            .from('users')
            .update({
                text_count: newTextCount,
                level: newLevel,
                balance: newBalance,
                push_name: pushName || user.push_name
            })
            .eq('id', user.id)

        if (error) {
            console.error('Error updating text count / level:', error)
        }
    } catch (err) {
        console.error('Error in incrementTextCount:', err)
    }
}

export async function getTopN(limit = 10) {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('push_name, balance')
            .order('balance', { ascending: false })
            .limit(limit)

        if (error) {
            console.error('Error fetching top users:', error)
            return []
        }
        return data || []
    } catch (err) {
        console.error('Error in getTopN:', err)
        return []
    }
}

export async function getProfile(userId) {
    try {
        const user = await getOrCreateUser(userId)
        
        const { count } = await supabase
            .from('users')
            .select('id', { count: 'exact', head: true })
            .gt('balance', user.balance)

        const rank = (count || 0) + 1

        return {
            balance: user.balance || 0,
            rank,
            level: user.level || 1,
            text_count: user.text_count || 0,
            stealWins: user.steal_wins || 0,
            stealLosses: user.steal_losses || 0,
            spouseId: user.spouse_id || null,
            vaultBalance: user.vault_balance || 0
        }
    } catch (err) {
        console.error('Error in getProfile:', err)
        return { balance: 0, rank: 'N/A', level: 1, text_count: 0, stealWins: 0, stealLosses: 0, spouseId: null, vaultBalance: 0 }
    }
}

export async function claimAirdrop(userId) {
    try {
        const user = await getOrCreateUser(userId)
        const now = new Date()

        if (user.last_airdrop) {
            const lastAirdrop = new Date(user.last_airdrop)
            const diffHours = (now - lastAirdrop) / (1000 * 60 * 60)
            if (diffHours < 24) {
                const hoursLeft = Math.ceil(24 - diffHours)
                return { error: `You already claimed your daily reward! Wait ${hoursLeft}h.` }
            }
        }

        const reward = 500
        const newBalance = (user.balance || 0) + reward

        await supabase
            .from('users')
            .update({ balance: newBalance, last_airdrop: now.toISOString() })
            .eq('id', user.id)

        return { amount: reward }
    } catch (err) {
        console.error('Error in claimAirdrop:', err)
        return { error: 'Failed to claim daily reward.' }
    }
}

export async function attemptSteal(stealerId, targetId) {
    try {
        const cleanStealer = stealerId.split('@')[0]
        const cleanTarget = targetId.split('@')[0]

        if (cleanStealer === cleanTarget) {
            return { error: "You can't steal from yourself!" }
        }

        const stealer = await getOrCreateUser(stealerId)
        const target = await getOrCreateUser(targetId)

        if (target.immunity_until && new Date(target.immunity_until) > new Date()) {
            return { error: `@${cleanTarget} currently has steal immunity active!` }
        }

        if (stealer.balance <= 0) {
            return { error: "You need at least some Habz to risk a steal!" }
        }

        if (target.balance <= 0) {
            return { error: `@${cleanTarget} has 0 Habz to steal!` }
        }

        // All-or-nothing: 40% chance of success, 60% chance of losing everything
        const isSuccess = Math.random() < 0.40

        if (isSuccess) {
            const stolenAmount = target.balance

            await supabase.from('users').update({
                balance: stealer.balance + stolenAmount,
                steal_wins: (stealer.steal_wins || 0) + 1
            }).eq('id', stealer.id)

            await supabase.from('users').update({
                balance: 0
            }).eq('id', target.id)

            return { success: true, movedAmount: stolenAmount }
        } else {
            const lostAmount = stealer.balance

            await supabase.from('users').update({
                balance: 0,
                steal_losses: (stealer.steal_losses || 0) + 1
            }).eq('id', stealer.id)

            await supabase.from('users').update({
                balance: target.balance + lostAmount
            }).eq('id', target.id)

            return { success: false, movedAmount: lostAmount }
        }
    } catch (err) {
        console.error('Error in attemptSteal:', err)
        return { error: 'Failed to execute steal attempt.' }
    }
}

export async function giveMoney(senderId, receiverId, amount) {
    try {
        if (amount <= 0) return { error: 'Amount must be greater than 0!' }
        
        const cleanSender = senderId.split('@')[0]
        const cleanReceiver = receiverId.split('@')[0]

        if (cleanSender === cleanReceiver) return { error: "You can't send money to yourself!" }

        const sender = await getOrCreateUser(senderId)
        if (sender.balance < amount) return { error: 'Insufficient balance!' }

        const receiver = await getOrCreateUser(receiverId)

        const fee = Math.floor(amount * 0.05)
        const netAmount = amount - fee

        await supabase.from('users').update({ balance: sender.balance - amount }).eq('id', sender.id)
        await supabase.from('users').update({ balance: receiver.balance + netAmount }).eq('id', receiver.id)

        return { amountReceived: netAmount, fee }
    } catch (err) {
        console.error('Error in giveMoney:', err)
        return { error: 'Failed to transfer money.' }
    }
}

export async function buyImmunity(userId, hours) {
    try {
        if (hours <= 0) return { error: 'Invalid duration!' }
        const cost = hours * 2000
        const user = await getOrCreateUser(userId)

        if (user.balance < cost) return { error: `You need ${cost.toLocaleString()} Habz for ${hours}h of immunity!` }

        const now = new Date()
        const currentImmunity = user.immunity_until && new Date(user.immunity_until) > now 
            ? new Date(user.immunity_until) 
            : now

        currentImmunity.setHours(currentImmunity.getHours() + hours)

        await supabase.from('users').update({
            balance: user.balance - cost,
            immunity_until: currentImmunity.toISOString()
        }).eq('id', user.id)

        return { hours, cost }
    } catch (err) {
        console.error('Error in buyImmunity:', err)
        return { error: 'Failed to buy immunity.' }
    }
}

export async function coinflip(userId, amount) {
    try {
        if (amount <= 0) return { error: 'Bet must be greater than 0!' }
        const user = await getOrCreateUser(userId)

        if (user.balance < amount) return { error: 'Insufficient balance!' }

        const won = Math.random() < 0.5
        const newBalance = won ? user.balance + amount : user.balance - amount

        await supabase.from('users').update({ balance: newBalance }).eq('id', user.id)

        return { won, amount }
    } catch (err) {
        console.error('Error in coinflip:', err)
        return { error: 'Failed to flip coin.' }
    }
}

export async function proposeMarriage(senderId, targetId) {
    try {
        const sender = await getOrCreateUser(senderId)
        const target = await getOrCreateUser(targetId)

        if (sender.spouse_id) return { error: 'You are already married!' }
        if (target.spouse_id) return { error: 'The person you tagged is already married!' }

        await supabase.from('users').update({ pending_proposal: sender.id }).eq('id', target.id)

        return { success: true }
    } catch (err) {
        console.error('Error in proposeMarriage:', err)
        return { error: 'Failed to propose.' }
    }
}

export async function acceptMarriage(userId) {
    try {
        const user = await getOrCreateUser(userId)
        if (!user.pending_proposal) return { error: 'You do not have any pending marriage proposals!' }

        const spouseId = user.pending_proposal

        await supabase.from('users').update({ spouse_id: spouseId, pending_proposal: null }).eq('id', user.id)
        await supabase.from('users').update({ spouse_id: user.id }).eq('id', spouseId)

        return { spouseId }
    } catch (err) {
        console.error('Error in acceptMarriage:', err)
        return { error: 'Failed to accept proposal.' }
    }
}

export async function divorce(userId) {
    try {
        const user = await getOrCreateUser(userId)
        if (!user.spouse_id) return { error: 'You are not married!' }

        const spouse = await getOrCreateUser(user.spouse_id)

        const totalVault = (user.vault_balance || 0) + (spouse.vault_balance || 0)
        const splitAmount = Math.floor(totalVault / 2)

        await supabase.from('users').update({
            spouse_id: null,
            balance: user.balance + splitAmount,
            vault_balance: 0
        }).eq('id', user.id)

        await supabase.from('users').update({
            spouse_id: null,
            balance: spouse.balance + splitAmount,
            vault_balance: 0
        }).eq('id', spouse.id)

        return { splitAmount }
    } catch (err) {
        console.error('Error in divorce:', err)
        return { error: 'Failed to divorce.' }
    }
}

export async function depositToVault(userId, amount) {
    try {
        if (amount <= 0) return { error: 'Amount must be greater than 0!' }
        const user = await getOrCreateUser(userId)

        if (!user.spouse_id) return { error: 'You must be married to deposit into a joint vault!' }
        if (user.balance < amount) return { error: 'Insufficient balance!' }

        await supabase.from('users').update({
            balance: user.balance - amount,
            vault_balance: (user.vault_balance || 0) + amount
        }).eq('id', user.id)

        return { success: true }
    } catch (err) {
        console.error('Error in depositToVault:', err)
        return { error: 'Failed to deposit into vault.' }
    }
}

export async function getVault(userId) {
    try {
        const user = await getOrCreateUser(userId)
        if (!user.spouse_id) return { error: 'You are not married!' }

        const spouse = await getOrCreateUser(user.spouse_id)
        const totalVault = (user.vault_balance || 0) + (spouse.vault_balance || 0)

        return { vaultBalance: totalVault }
    } catch (err) {
        console.error('Error in getVault:', err)
        return { error: 'Failed to fetch vault balance.' }
    }
                      }
            
