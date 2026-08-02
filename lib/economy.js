import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase environment variables are missing! Check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

// Helper: Get or create user profile
export async function getUser(userId, pushName = 'User') {
    let { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single()

    if (error || !data) {
        const newUser = {
            id: userId,
            push_name: pushName,
            balance: 1000,
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
            .single()
        
        if (createError) {
            console.error('Error creating user:', createError.message)
            return newUser
        }
        return created
    }
    return data
}

// Helper: Update user balance and stats
export async function updateUser(userId, updates) {
    const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', userId)
        .select()
        .single()

    if (error) {
        console.error('Error updating user:', error.message)
    }
    return data
}

// Format custom leaderboard layout
export async function getLeaderboardFormatted() {
    const { data, error } = await supabase
        .from('users')
        .select('push_name, balance')
        .order('balance', { ascending: false })
        .limit(20)

    if (error || !data || data.length === 0) {
        return "🏆 *HABIBI TOP BALANCES* 🏆\n\nNo records found yet!"
    }

    let text = "🏆 *Top 20 Flexers* 🏆\n\n"
    data.forEach((user, index) => {
        const name = user.push_name || 'Anonymous'
        const bal = Number(user.balance || 0).toLocaleString()
        text += `${index + 1}. *${name}* :\n     *BALANCE* - _₻${bal}_\n\n`
    })

    return text.trim()
}
