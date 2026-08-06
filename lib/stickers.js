import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Baileys can't read WhatsApp's own "favorite stickers" tray — that's
// client-side, not exposed over the multi-device protocol. This is Habibi's
// own pack instead: an admin seeds it via .savesticker (reply to a sticker),
// and getRandomSticker() is what powers the "reply to Habibi with a sticker,
// she sends one back" behavior.

export async function saveSticker(buffer, addedBy) {
    const { error } = await supabase.from('sticker_pack').insert({
        webp_base64: buffer.toString('base64'),
        added_by: addedBy
    })
    if (error) {
        console.error('Error saving sticker:', error.message)
        return false
    }
    return true
}

export async function getRandomSticker() {
    const { data, error } = await supabase.rpc('get_random_sticker')
    if (error) {
        console.error('Error fetching random sticker:', error.message)
        return null
    }
    const row = data?.[0]
    if (!row) return null
    return Buffer.from(row.webp_base64, 'base64')
}

export async function getStickerPackSize() {
    const { count, error } = await supabase.from('sticker_pack').select('*', { count: 'exact', head: true })
    if (error) {
        console.error('Error counting sticker pack:', error.message)
        return 0
    }
    return count || 0
}
