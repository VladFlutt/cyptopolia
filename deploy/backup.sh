#!/usr/bin/env bash
# Daily snapshot of the chain state and the database. Add to cron: 0 4 * * * /opt/cryptopolia/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
dest=/var/backups/cryptopolia/$(date +%F)
mkdir -p "$dest"
docker compose exec -T backend node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/cryptopolia.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp backend:/data/backup.db "$dest/cryptopolia.db"
docker compose cp chain:/data/state.json "$dest/state.json"
find /var/backups/cryptopolia -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
