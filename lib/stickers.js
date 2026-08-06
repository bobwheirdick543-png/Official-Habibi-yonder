import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Baileys can't read WhatsApp's own "favorite stickers" tray — that's
// client-side, not exposed over the multi-device protocol. This is Habibi's
// own pack instead: an admin seeds it via .savesticker (reply to a sticker),
// and getRandomSticker() is what powers the "reply to Habibi with a sticker,
// she sends one back" behavior.

// Every sticker WhatsApp shows carries a pack-name/publisher stamped into a
// raw EXIF chunk in the WebP file itself (this is what "Sticker Pack: X by Y"
// on long-press reads from). Rewriting it here means whatever pack name the
// sticker originally shipped with gets overwritten every time Habibi sends
// one back — the alias is applied fresh at send-time, not baked in at save-time.
const STICKER_PACK_NAME = '𝓗𝓪𝓫𝓲𝓫𝓲 ﷽'
const STICKER_PACK_PUBLISHER = 'Habibi'

function addStickerExif(buffer, packName = STICKER_PACK_NAME, publisher = STICKER_PACK_PUBLISHER) {
    try {
        const json = {
            'sticker-pack-id': 'habibi-' + Date.now(),
            'sticker-pack-name': packName,
            'sticker-pack-publisher': publisher,
            'emojis': ['🦩']
        }
        const exifAttr = Buffer.from([
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x16, 0x00, 0x00, 0x00
        ])
        const jsonBuf = Buffer.from(JSON.stringify(json), 'utf-8')
        const exifData = Buffer.concat([exifAttr, jsonBuf])
        exifData.writeUIntLE(jsonBuf.length, 14, 4)
        const exifChunk = Buffer.allocUnsafe(8 + exifData.length)
        exifChunk.write('EXIF', 0, 'ascii')
        exifChunk.writeUInt32LE(exifData.length, 4)
        exifData.copy(exifChunk, 8)
        const newBuffer = Buffer.concat([
            buffer.subarray(0, 12),
            exifChunk,
            buffer.subarray(12)
        ])
        newBuffer.writeUInt32LE(newBuffer.length - 8, 4)
        return newBuffer
    } catch (err) {
        console.error('Error writing sticker EXIF:', err.message)
        return buffer
    }
}

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

// In-memory only — tracks the last sticker sent so the same one never fires
// twice in a row. Resets on restart, which is fine; worst case is one
// possible repeat right after a redeploy.
let lastStickerId = null

export async function getRandomSticker() {
    const { data, error } = await supabase.rpc('get_random_sticker', { exclude_id: lastStickerId })
    if (error) {
        console.error('Error fetching random sticker:', error.message)
        return null
    }
    const row = data?.[0]
    if (!row) return null
    lastStickerId = row.id
    const rawBuffer = Buffer.from(row.webp_base64, 'base64')
    return addStickerExif(rawBuffer)
}

export async function getStickerPackSize() {
    const { count, error } = await supabase.from('sticker_pack').select('*', { count: 'exact', head: true })
    if (error) {
        console.error('Error counting sticker pack:', error.message)
        return 0
    }
    return count || 0
}
