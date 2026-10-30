#!/bin/bash
# Holt neue Versionen aus dem privaten Repo und startet den Server neu (Stand bleibt im Volume erhalten).
exec 9>/var/lock/tape-update.lock; flock -n 9 || exit 0
cd /opt/tape/repo || exit 1
git fetch -q origin main || exit 0
L=$(git rev-parse HEAD); R=$(git rev-parse origin/main)
if [ "$L" != "$R" ]; then
  echo "$(date -Is) Update $L -> $R"
  git reset -q --hard origin/main && docker compose up -d --build && docker image prune -f >/dev/null
fi
