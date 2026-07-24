import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { getOrCreateUser, getTopN, getProfile } from './economy.js'
import { broadcastUpdate } from './websocket.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

export const adminRouter = express.Router()

function requireAdmin(req, res, next) {
    const secret = req.headers['x-admin-secret']
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
}

adminRouter.use(express.json())
adminRouter.use(requireAdmin)

adminRouter.get('/leaderboard/global', async (req, res) => {
    const top = await getTopN(20)
    res.json({ leaderboard: top })
})

adminRouter.get('/leaderboard/:groupId', async (req, res) => {
    const { groupId } = req.params

    const { data: members, error } = await supabase
        .from('group_members')
        .select('member_id, users(member_id, push_name, balance, level)')
        .eq('group_id', groupId)

    if (error) {
        return res.status(500).json({ error: error.message })
    }

    const sorted = (members || [])
        .map((m) => m.users)
        .filter(Boolean)
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 20)

    res.json({ leaderboard: sorted })
})

adminRouter.get('/groups', async (req, res) => {
    const { data, error } = await supabase.from('groups').select('*')
    if (error) return res.status(500).json({ error: error.message })
    res.json({ groups: data })
})

adminRouter.get('/user/:memberId', async (req, res) => {
    const profile = await getProfile(req.params.memberId)
    res.json({ profile })
})

adminRouter.get('/transactions/:memberId', async (req, res) => {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .or(`sender_id.eq.${req.params.memberId},receiver_id.eq.${req.params.memberId}`)
        .order('created_at', { ascending: false })
        .limit(50)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ transactions: data })
})

adminRouter.post('/broadcast/airdrop', async (req, res) => {
    const { groupId, amount } = req.body

    if (!groupId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'groupId and a positive amount are required' })
    }

    const { data: airdrop, error } = await supabase
        .from('airdrops')
        .insert({ group_id: groupId, amount })
        .select()
        .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })

    const sock = req.app.get('sock')
    if (sock) {
        await sock.sendMessage(groupId, {
            text: `🦩 AirDrop incoming, first to send .claim gets ₻${amount.toLocaleString()} added to their balance`
        })
    }

    broadcastUpdate('airdrop_sent', { groupId, amount })
    res.json({ success: true, airdrop })
})

adminRouter.post('/broadcast/message', async (req, res) => {
    const { groupId, text } = req.body

    if (!groupId || !text) {
        return res.status(400).json({ error: 'groupId and text are required' })
    }

    const sock = req.app.get('sock')
    if (!sock) {
        return res.status(503).json({ error: 'WhatsApp connection not ready' })
    }

    await sock.sendMessage(groupId, { text })
    res.json({ success: true })
})

adminRouter.post('/adjust-balance', async (req, res) => {
    const { memberId, amount, reason } = req.body

    if (!memberId || amount === undefined || amount === null) {
        return res.status(400).json({ error: 'memberId and amount are required' })
    }

    const user = await getOrCreateUser(memberId)
    const newBalance = user.balance + amount

    await supabase
        .from('users')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        group_id: null,
        amount,
        tx_type: 'admin_adjustment',
        description: reason || 'Manual admin adjustment'
    })

    broadcastUpdate('balance_adjusted', { memberId, newBalance })
    res.json({ success: true, newBalance })
})

adminRouter.post('/reset-steals', async (req, res) => {
    const { memberId } = req.body

    if (!memberId) {
        return res.status(400).json({ error: 'memberId is required' })
    }

    await supabase
        .from('users')
        .update({ steal_targets_24h: [], last_steal_time: null, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    res.json({ success: true })
})
