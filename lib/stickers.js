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

// Walks the RIFF chunk list of a WebP file (everything after the 12-byte
// "RIFF"+size+"WEBP" header) so we can inspect/rewrite it chunk-by-chunk
// instead of blindly splicing bytes.
function parseWebpChunks(buffer) {
    const chunks = []
    let offset = 12
    while (offset + 8 <= buffer.length) {
        const fourCC = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const dataStart = offset + 8
        const dataEnd = dataStart + size
        // Chunks are padded to an even byte count.
        const end = size % 2 === 1 ? dataEnd + 1 : dataEnd
        chunks.push({ fourCC, dataStart, dataEnd, start: offset, end })
        offset = end
    }
    return chunks
}

// The previous version of this function spliced a raw EXIF chunk in right
// after the 12-byte "WEBP" header, ahead of VP8X. Per the WebP RIFF spec,
// VP8X (if present) MUST be the very first chunk, and EXIF must come after
// the image data — inserting it first produced a structurally invalid file
// that WhatsApp's client rejected outright ("Can't view sticker information"),
// instead of just losing the pack name like a minor EXIF mistake would.
// This version parses the existing chunks, keeps them in spec-compliant
// order, sets the EXIF flag bit in VP8X, and appends the EXIF chunk last.
function addStickerExif(buffer, packName = STICKER_PACK_NAME, publisher = STICKER_PACK_PUBLISHER) {
    try {
        if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
            console.error('addStickerExif: not a valid WebP buffer, skipping EXIF injection')
            return buffer
        }

        const chunks = parseWebpChunks(buffer)
        const vp8x = chunks.find((c) => c.fourCC === 'VP8X')
        if (!vp8x) {
            // Simple-format WebP (no VP8X) can't legally carry metadata chunks.
            // Sending it as-is beats corrupting it.
            console.error('addStickerExif: sticker has no VP8X chunk, skipping EXIF injection')
            return buffer
        }

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
        const exifPayload = Buffer.concat([exifAttr, jsonBuf])
        exifPayload.writeUIntLE(jsonBuf.length, 14, 4)

        const exifChunkHeader = Buffer.alloc(8)
        exifChunkHeader.write('EXIF', 0, 'ascii')
        exifChunkHeader.writeUInt32LE(exifPayload.length, 4)
        let exifChunk = Buffer.concat([exifChunkHeader, exifPayload])
        if (exifChunk.length % 2 === 1) exifChunk = Buffer.concat([exifChunk, Buffer.from([0x00])])

        // Set the EXIF-present flag bit (bit 3 of the flags byte) in VP8X.
        const vp8xData = Buffer.from(buffer.subarray(vp8x.dataStart, vp8x.dataEnd))
        vp8xData[0] = vp8xData[0] | 0x08
        const vp8xChunkHeader = Buffer.alloc(8)
        vp8xChunkHeader.write('VP8X', 0, 'ascii')
        vp8xChunkHeader.writeUInt32LE(vp8xData.length, 4)
        let vp8xChunk = Buffer.concat([vp8xChunkHeader, vp8xData])
        if (vp8xChunk.length % 2 === 1) vp8xChunk = Buffer.concat([vp8xChunk, Buffer.from([0x00])])

        // Reassemble: VP8X first (spec-required), then every other original
        // chunk in its original order (dropping any pre-existing EXIF so we
        // don't end up with duplicates), then our fresh EXIF chunk last.
        const otherChunks = chunks
            .filter((c) => c.fourCC !== 'VP8X' && c.fourCC !== 'EXIF')
            .map((c) => buffer.subarray(c.start, c.end))

        const body = Buffer.concat([vp8xChunk, ...otherChunks, exifChunk])
        const header = Buffer.alloc(12)
        header.write('RIFF', 0, 'ascii')
        header.writeUInt32LE(4 + body.length, 4) // "WEBP" + all chunks
        header.write('WEBP', 8, 'ascii')

        return Buffer.concat([header, body])
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
