import { WebSocketServer, WebSocket } from 'ws'

let wss = null

export function initWebSocket(server) {
    wss = new WebSocketServer({ server, path: '/ws' })

    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const secret = url.searchParams.get('secret')

        if (secret !== process.env.ADMIN_SECRET) {
            ws.close(4401, 'Unauthorized')
            return
        }

        ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }))

        ws.on('error', (error) => {
            console.error('WebSocket client error:', error)
        })
    })

    console.log('WebSocket server ready on /ws')
}

export function broadcastUpdate(type, payload) {
    if (!wss) return

    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() })

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message)
        }
    })
}
