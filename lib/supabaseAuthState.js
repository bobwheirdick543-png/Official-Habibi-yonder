import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
)

async function readData(key) {
    const { data, error } = await supabase
        .from('wa_session')
        .select('value')
        .eq('key', key)
        .maybeSingle()

    if (error || !data) return null
    return JSON.parse(data.value, BufferJSON.reviver)
}

async function writeData(key, value) {
    const serialized = JSON.stringify(value, BufferJSON.replacer)
    await supabase
        .from('wa_session')
        .upsert({ key, value: serialized, updated_at: new Date().toISOString() })
}

async function removeData(key) {
    await supabase
        .from('wa_session')
        .delete()
        .eq('key', key)
}

export async function useSupabaseAuthState() {
    const creds = (await readData('creds')) || initAuthCreds()

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`)
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value)
                            }
                            data[id] = value
                        })
                    )
                    return data
                },
                set: async (data) => {
                    const tasks = []
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            const key = `${category}-${id}`
                            tasks.push(value ? writeData(key, value) : removeData(key))
                        }
                    }
                    await Promise.all(tasks)
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds)
        }
    }
}
