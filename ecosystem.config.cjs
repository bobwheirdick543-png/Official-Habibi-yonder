module.exports = {
    apps: [
        {
            name: 'habibi',
            script: 'index.js',
            node_args: '--max-old-space-size=512',
            max_memory_restart: '400M',
            autorestart: true,
            restart_delay: 3000
        }
    ]
}
