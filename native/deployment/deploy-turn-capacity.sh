#!/bin/sh
set -eu

# Kept under the historical filename so existing runbooks continue to work.
# This migration removes every coturn/signal bandwidth ceiling.
turn_config="${TURN_CONFIG_FILE:-/etc/turnserver.conf}"
signal_env="${SIGNAL_ENV_FILE:-/etc/yiqikan-signal.env}"
backup_root="${BACKUP_ROOT:-/etc/yiqikan-backups}"
turn_min_port="${TURN_MIN_PORT:-32768}"
turn_max_port="${TURN_MAX_PORT:-65535}"
turn_max_allocate_lifetime="${TURN_MAX_ALLOCATE_LIFETIME:-7200}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
turn_backup="${backup_root}/turnserver.conf.${timestamp}"
signal_backup="${backup_root}/yiqikan-signal.env.${timestamp}"
turn_candidate="${turn_config}.next.$$"
signal_candidate="${signal_env}.next.$$"

cleanup() {
  rm -f "$turn_candidate" "$signal_candidate"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "$1" >&2
  exit 1
}

remove_setting() {
  file="$1"
  key="$2"
  sed -i "/^[[:space:]]*${key}[[:space:]]*=/d" "$file"
}

replace_one() {
  file="$1"
  key="$2"
  value="$3"
  count="$(grep -Ec "^${key}=" "$file" || true)"
  if [ "$count" -ne 1 ]; then
    fail "${file} must contain exactly one ${key}= entry"
  fi
  sed -i "s|^${key}=.*|${key}=${value}|" "$file"
}

upsert_one() {
  file="$1"
  key="$2"
  value="$3"
  count="$(grep -Ec "^${key}=" "$file" || true)"
  if [ "$count" -gt 1 ]; then
    fail "${file} must not contain duplicate ${key}= entries"
  fi
  if [ "$count" -eq 1 ]; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

setting_value() {
  file="$1"
  key="$2"
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" |
    tail -n 1 |
    sed "s/[[:space:]]*#.*$//; s/^[[:space:]'\"]*//; s/[[:space:]'\"]*$//"
}

validate_required_configuration() {
  turn_file="$1"
  signal_file="$2"
  external_ip="$(setting_value "$turn_file" "external-ip")"
  realm="$(setting_value "$turn_file" "realm")"
  static_secret="$(setting_value "$turn_file" "static-auth-secret")"
  turn_urls="$(setting_value "$signal_file" "TURN_URLS")"
  signal_secret="$(setting_value "$signal_file" "TURN_SECRET")"
  signal_secret_file="$(setting_value "$signal_file" "TURN_SECRET_FILE")"

  case "$external_ip" in
    "" | "0.0.0.0" | *__*)
      fail "${turn_file} must contain a real, non-empty external-ip"
      ;;
  esac
  case "$realm" in
    "" | *__*)
      fail "${turn_file} must contain a real, non-empty realm"
      ;;
  esac
  case "$static_secret" in
    "" | *__*)
      fail "${turn_file} must contain a real, non-empty static-auth-secret"
      ;;
  esac
  if ! grep -Eq '^[[:space:]]*use-auth-secret([[:space:]]*=.*)?[[:space:]]*$' "$turn_file"; then
    fail "${turn_file} must enable use-auth-secret"
  fi
  case "$turn_urls" in
    "" | *__*)
      fail "${signal_file} must contain non-empty TURN_URLS"
      ;;
  esac
  if [ -z "$signal_secret" ] && [ -z "$signal_secret_file" ]; then
    fail "${signal_file} must contain TURN_SECRET or TURN_SECRET_FILE"
  fi
  if [ -z "$signal_secret" ] &&
    { [ ! -f "$signal_secret_file" ] || [ ! -r "$signal_secret_file" ]; }; then
    fail "TURN_SECRET_FILE referenced by ${signal_file} is not readable"
  fi
}

wait_for_signal() {
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if node -e "
      fetch('http://127.0.0.1:8787/readyz')
        .then(async response => {
          const body = await response.json();
          if (
            !response.ok ||
            body.protocolVersion !== 3 ||
            body.limits?.maxParticipantsPerRoom !== 8 ||
            body.relayCapacityBps !== null ||
            body.relaySessionCapacityBps !== null ||
            body.relayCapacityEnforced !== false
          ) process.exit(1);
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
  echo "${reason}; rolling back TURN and signal configuration" >&2
  cp -a "$turn_backup" "$turn_config"
  cp -a "$signal_backup" "$signal_env"
  systemctl restart coturn.service >/dev/null 2>&1 || true
  systemctl restart yiqikan-signal.service >/dev/null 2>&1 || true
  systemctl --no-pager --full status coturn.service >&2 || true
  systemctl --no-pager --full status yiqikan-signal.service >&2 || true
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "deploy-turn-capacity.sh must run as root"
fi
if [ ! -f "$turn_config" ] || [ ! -f "$signal_env" ]; then
  fail "TURN config or signal environment file is missing"
fi
case "${turn_min_port}:${turn_max_port}:${turn_max_allocate_lifetime}" in
  *[!0-9:]*)
    fail "TURN port values must be positive integers"
    ;;
esac
if [ "$turn_min_port" -lt 1024 ] ||
  [ "$turn_max_port" -gt 65535 ] ||
  [ "$turn_min_port" -ge "$turn_max_port" ]; then
  fail "invalid TURN relay port range"
fi
if [ "$turn_max_allocate_lifetime" -lt 600 ] ||
  [ "$turn_max_allocate_lifetime" -gt 86400 ]; then
  fail "invalid TURN maximum allocation lifetime"
fi

validate_required_configuration "$turn_config" "$signal_env"

mkdir -p "$backup_root"
chmod 700 "$backup_root"
cp -a "$turn_config" "$turn_backup"
cp -a "$signal_env" "$signal_backup"
cp -a "$turn_config" "$turn_candidate"
cp -a "$signal_env" "$signal_candidate"

replace_one "$turn_candidate" "min-port" "$turn_min_port"
replace_one "$turn_candidate" "max-port" "$turn_max_port"
upsert_one \
  "$turn_candidate" \
  "max-allocate-lifetime" \
  "$turn_max_allocate_lifetime"
remove_setting "$turn_candidate" "max-bps"
remove_setting "$turn_candidate" "bps-capacity"
remove_setting "$signal_candidate" "RELAY_CAPACITY_BPS"
remove_setting "$signal_candidate" "RELAY_SESSION_CAPACITY_BPS"
validate_required_configuration "$turn_candidate" "$signal_candidate"

chown --reference="$turn_config" "$turn_candidate"
chmod --reference="$turn_config" "$turn_candidate"
chown --reference="$signal_env" "$signal_candidate"
chmod --reference="$signal_env" "$signal_candidate"
mv -f "$turn_candidate" "$turn_config"
mv -f "$signal_candidate" "$signal_env"

if ! systemctl restart coturn.service; then
  rollback "coturn restart failed"
fi
if ! systemctl is-active --quiet coturn.service ||
  ! ss -H -lun | grep -Eq ':3478[[:space:]]' ||
  ! ss -H -ltn | grep -Eq ':3478[[:space:]]'; then
  rollback "coturn listeners did not become healthy"
fi
if ! systemctl restart yiqikan-signal.service || ! wait_for_signal; then
  rollback "signal service failed after removing bandwidth limits"
fi

printf '%s\n' \
  "TURN unlimited-bandwidth configuration deployed" \
  "min-port=${turn_min_port}" \
  "max-port=${turn_max_port}" \
  "max-allocate-lifetime=${turn_max_allocate_lifetime}" \
  "bandwidth-limit=none" \
  "turn-backup=${turn_backup}" \
  "signal-backup=${signal_backup}"
