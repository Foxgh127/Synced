#!/bin/sh
set -eu

signal_env="${SIGNAL_ENV_FILE:-/etc/yiqikan-signal.env}"
backup_root="${BACKUP_ROOT:-/etc/yiqikan-backups}"
default_ice_servers_json='[{"urls":["stun:43.161.195.12:3478"]}]'
ice_servers_json="${ICE_SERVERS_JSON:-$default_ice_servers_json}"
turn_urls="${TURN_URLS:-turn:43.161.195.12:3478?transport=udp,turn:43.161.195.12:3478?transport=tcp}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${backup_root}/yiqikan-signal.env.standby.${timestamp}"
candidate="${signal_env}.next.$$"

cleanup() {
  rm -f "$candidate"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "$1" >&2
  exit 1
}

replace_one() {
  file="$1"
  key="$2"
  value="$3"
  count="$(grep -Ec "^${key}=" "$file" || true)"
  if [ "$count" -ne 1 ]; then
    fail "${file} must contain exactly one ${key}= entry"
  fi
  sed -i "s|^${key}=.*|${key}='${value}'|" "$file"
}

wait_for_signal() {
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if node -e "
      fetch('http://127.0.0.1:8787/readyz')
        .then(async response => {
          const body = await response.json();
          if (!response.ok || body.protocolVersion !== 3) process.exit(1);
        })
        .catch(() => process.exit(1));
    "; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

rollback() {
  reason="$1"
  echo "${reason}; restoring standby signal routing" >&2
  cp -a "$backup" "$signal_env"
  systemctl restart yiqikan-signal.service >/dev/null 2>&1 || true
  systemctl --no-pager --full status yiqikan-signal.service >&2 || true
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "deploy-standby-routing.sh must run as root"
fi
if [ ! -f "$signal_env" ]; then
  fail "signal environment file is missing"
fi
mkdir -p "$backup_root"
chmod 700 "$backup_root"
cp -a "$signal_env" "$backup"
cp -a "$signal_env" "$candidate"
replace_one "$candidate" "ICE_SERVERS_JSON" "$ice_servers_json"
replace_one "$candidate" "TURN_URLS" "$turn_urls"
chown --reference="$signal_env" "$candidate"
chmod --reference="$signal_env" "$candidate"
mv -f "$candidate" "$signal_env"

if ! systemctl restart yiqikan-signal.service || ! wait_for_signal; then
  rollback "standby signal routing failed readiness checks"
fi

printf '%s\n' \
  "Standby signal routing deployed" \
  "ice-servers=${ice_servers_json}" \
  "turn-urls=${turn_urls}" \
  "backup=${backup}"
