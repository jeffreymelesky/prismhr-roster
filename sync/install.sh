#!/usr/bin/env bash
# Installs the PrismHR -> Supabase sync on a fresh Ubuntu/Debian server.
# Usage (as root, from the server's console):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/<you>/prismhr-roster/main/sync/install.sh)"
# You'll be asked for the secrets; they're saved only on this server in /opt/prismhr-sync/.env (root-only).
set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/jeffreymelesky/prismhr-roster/main}"
DIR=/opt/prismhr-sync

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (prefix with sudo)."; exit 1; fi
command -v python3 >/dev/null || { apt-get update -y && apt-get install -y python3; }
command -v curl >/dev/null || { apt-get update -y && apt-get install -y curl; }

mkdir -p "$DIR"
curl -fsSL "$REPO_RAW/sync/prismhr_sync.py" -o "$DIR/prismhr_sync.py"
chmod 700 "$DIR/prismhr_sync.py"

ask() { local prompt="$1" def="${2:-}" v; read -r -p "$prompt${def:+ [$def]}: " v </dev/tty; echo "${v:-$def}"; }
ask_secret() { local prompt="$1" v; read -r -s -p "$prompt: " v </dev/tty; echo >&2; echo "$v"; }

echo
echo "== PrismHR settings =="
BASE=$(ask "PrismHR API base URL" "https://api.prismhr.com/api-1.30/services/rest/")
USER_ID=$(ask "Web Service User ID")
PEO=$(ask "PEO ID")
CLIENT=$(ask "Client ID to sync")
PW=$(ask_secret "Web Service User password (hidden)")
echo
echo "== Supabase settings =="
SURL=$(ask "Supabase project URL (https://xxxx.supabase.co)")
SKEY=$(ask_secret "Supabase secret / service_role key (hidden)")

umask 077
cat > "$DIR/.env" <<EOF
PRISM_BASE_URL=$BASE
PRISM_USER=$USER_ID
PRISM_PASSWORD=$PW
PRISM_PEO_ID=$PEO
PRISM_CLIENT_ID=$CLIENT
SUPABASE_URL=$SURL
SUPABASE_SECRET_KEY=$SKEY
EOF
chmod 600 "$DIR/.env"

# Every minute: sync only if someone pressed "Refresh" on the website (no PrismHR contact otherwise).
# Nightly at 07:17 UTC (about 3:17 AM Eastern): full sync. flock prevents overlapping runs.
cat > /etc/cron.d/prismhr-sync <<CRON
* * * * * root /usr/bin/flock -n /run/prismhr-sync.lock /usr/bin/python3 $DIR/prismhr_sync.py --if-requested >> /var/log/prismhr-sync.log 2>&1
17 7 * * * root /usr/bin/flock -w 120 /run/prismhr-sync.lock /usr/bin/python3 $DIR/prismhr_sync.py >> /var/log/prismhr-sync.log 2>&1
CRON
chmod 644 /etc/cron.d/prismhr-sync

echo
echo "This server's public IP (add it to Allowed IPs in PrismHR if you haven't):"
curl -fsS https://api.ipify.org || true
echo
echo
echo "Running first sync now..."
/usr/bin/python3 "$DIR/prismhr_sync.py" || true
echo
echo "Done. Re-run any time with:  python3 $DIR/prismhr_sync.py"
