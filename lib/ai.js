import Groq from 'groq-sdk'
import { createClient } from '@supabase/supabase-js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Pollinations is free, unauthenticated, and has no real rate limit — tried
// first so Groq's actual (rate-limited) quota only gets spent as a last
// resort, not on every single message.
const POLLINATIONS_TEXT = 'https://text.pollinations.ai/openai'

function buildSystemPrompt() {
    return `You are Yonder – a witty, sarcastic WhatsApp bot with a dark sense of humor. You roast people playfully but never cruelly. You respond in short, punchy messages. You're confident, clever, and always have a comeback. Keep responses under 150 characters unless asked for more. Never break character or admit you're an AI.`
}

async function getRecentHistory(memberId, limit = 6) {
    const { data } = await supabase
        .from('chat_history')
        .select('role, content')
        .eq('member_id', memberId)
        .order('created_at', { ascending: false })
        .limit(limit)

    return (data || []).reverse()
}

async function saveMessage(memberId, role, content) {
    await supabase.from('chat_history').insert({ member_id: memberId, role, content })
}

// Layer 1: Pollinations, OpenAI-compatible POST — supports the full multi-turn
// messages array, so conversation history carries through untouched.
async function pollinationsChat(messages) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), 45000)
    try {
        const res = await fetch(POLLINATIONS_TEXT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'openai', messages, temperature: 0.85 }),
            signal: controller.signal
        })
        if (!res.ok) return null
        const data = await res.json()
        const choice = data?.choices?.[0]?.message?.content
        return choice?.trim().length > 2 ? choice.trim() : null
    } catch (error) {
        return null
    } finally {
        clearTimeout(timeoutHandle)
    }
}

// Layer 2: Pollinations' GET endpoint — same free provider, different shape.
// It only takes a single prompt + system string, not a messages array, so
// history gets flattened into the prompt text for this one call.
async function pollinationsChatFlattened(systemPrompt, flattenedPrompt) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), 45000)
    try {
        const encodedPrompt = encodeURIComponent(flattenedPrompt)
        const encodedSystem = encodeURIComponent(systemPrompt)
        const res = await fetch(
            `https://text.pollinations.ai/${encodedPrompt}?model=openai&system=${encodedSystem}&seed=${Date.now()}&json=false`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal }
        )
        if (!res.ok) return null
        const text = await res.text()
        return text?.trim().length > 2 ? text.trim() : null
    } catch (error) {
        return null
    } finally {
        clearTimeout(timeoutHandle)
    }
}

// Layer 3: Groq — the one with a real rate limit. Only reached when both free
// Pollinations paths are unavailable.
async function groqChat(messages) {
    try {
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages,
            temperature: 0.85,
            max_tokens: 200
        })
        return completion.choices[0]?.message?.content?.trim() || null
    } catch (error) {
        console.error('Groq API error:', error)
        return null
    }
}

export async function getAIReply(memberId, senderName, text) {
    const history = await getRecentHistory(memberId)
    const systemPrompt = buildSystemPrompt()
    const userTurn = `${senderName}: ${text}`

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: userTurn }
    ]

    let reply = await pollinationsChat(messages)

    if (!reply) {
        const flattenedHistory = history.map((h) => `${h.role === 'user' ? senderName : 'Yonder'}: ${h.content}`).join('\n')
        const flattenedPrompt = flattenedHistory ? `${flattenedHistory}\n${userTurn}` : userTurn
        reply = await pollinationsChatFlattened(systemPrompt, flattenedPrompt)
    }

    if (!reply) {
        reply = await groqChat(messages)
    }

    if (!reply) reply = `Nice try ${senderName}, but your message made zero sense.`

    // Ensure no hyphens or em-dashes leak into text
    reply = reply.replace(/[—–-]/g, ' ')

    // History logging happens in the background — the person shouldn't wait on
    // it, and there's no reason the two writes need to be sequential either.
    Promise.all([
        saveMessage(memberId, 'user', userTurn),
        saveMessage(memberId, 'assistant', reply)
    ]).catch((err) => console.error('Error saving chat history:', err))

    return reply
}
