#!/bin/bash
# Holt neue Versionen aus dem privaten Repo, baut, prüft die Gesundheit und fällt bei Fehlern auf die alte Version zurück.
# Der Stand (Volume /data) bleibt immer erhalten. Meldet Erfolg/Rückfall per ntfy (Werte aus .env).
exec 9>/var/lock/tape-update.lock; flock -n 9 || exit 0
cd /opt/tape/repo || exit 1
set -a; [ -f .env ] && . ./.env; set +a
say() { [ -n "$NTFY_TOPIC" ] && curl -fsS --max-time 10 -H "Title: $1" -d "$2" "${NTFY_URL:-https://ntfy.sh}/$NTFY_TOPIC" >/dev/null 2>&1; true; }
healthy() { for i in $(seq 1 18); do docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0; sleep 5; done; return 1; }
git fetch -q origin main || exit 0
L=$(git rev-parse HEAD); R=$(git rev-parse origin/main)
[ "$L" = "$R" ] && exit 0
[ "$(git rev-parse -q --verify refs/tape/bad)" = "$R" ] && exit 0   # bekannt kaputte Version nicht erneut
echo "$(date -Is) Update $L -> $R"
git reset -q --hard origin/main
if docker compose up -d --build && healthy; then
  docker image prune -f >/dev/null; docker builder prune -f --filter until=168h >/dev/null 2>&1
  echo "$(date -Is) ok"; say "Tape aktualisiert" "Version ${R:0:7} läuft."
else
  echo "$(date -Is) FEHLER – zurück auf $L"
  git reset -q --hard "$L"; docker compose up -d --build
  if healthy; then say "Tape-Update fehlgeschlagen" "Version ${R:0:7} startete nicht – alte Version ${L:0:7} läuft wieder."; else say "Tape-Server gestört" "Update ${R:0:7} und Rückfall auf ${L:0:7} fehlgeschlagen – bitte Logs prüfen."; fi
  # Diese Version nicht jede 5 Minuten neu versuchen: erst wenn ein neuerer Stand kommt
  git update-ref refs/tape/bad "$R"
fi
