module.exports = {
    apps: [
        {
            name: 'habibi',
            script: 'index.js',
            node_args: '--max-old-space-size=512',
            autorestart: true,
            restart_delay: 3000
        }
    ]
}
