#!/bin/sh
set -eu

source_bundle="${1:-/tmp/yiqikan-signal.mjs}"
install_root="/opt/yiqikan"
live_bundle="${install_root}/yiqikan-signal.mjs"
release_root="${install_root}/releases"
candidate="${install_root}/.yiqikan-signal.mjs.next"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${release_root}/yiqikan-signal.${timestamp}.mjs"
install_uid=0
install_gid=0
install_mode=0644

# Existing deployments predate the dedicated yiqikan account on some hosts.
# Some also use systemd DynamicUser, for which there is intentionally no
# persistent account to chown files to. Preserve the live bundle's numeric
# ownership and readable mode instead of assuming a local account exists.
if [ -e "$live_bundle" ]; then
  install_uid="$(stat -c %u "$live_bundle")"
  install_gid="$(stat -c %g "$live_bundle")"
  install_mode="$(stat -c %a "$live_bundle")"
elif command -v getent >/dev/null 2>&1 &&
  account_entry="$(getent passwd yiqikan 2>/dev/null)"; then
  install_uid="$(printf '%s' "$account_entry" | cut -d: -f3)"
  install_gid="$(printf '%s' "$account_entry" | cut -d: -f4)"
  install_mode=0640
fi

wait_for_health() {
  endpoint="$1"
  expected_protocol="${2:-}"
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if node -e "
      fetch('http://127.0.0.1:8787/${endpoint}')
        .then(async response => {
          const body = await response.json();
          const expectedProtocol = ${expected_protocol:-0};
          if (!response.ok) process.exit(1);
          if (expectedProtocol > 0) {
            if (body.protocolVersion !== expectedProtocol) process.exit(1);
          } else if (body.ok !== true) {
            process.exit(1);
          }
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
  echo "$reason; rolling back" >&2
  if [ -f "$backup" ]; then
    install -o "$install_uid" -g "$install_gid" -m "$install_mode" "$backup" "$live_bundle"
    if systemctl restart yiqikan-signal.service &&
      wait_for_health "health"; then
      echo "Previous signal bundle restored and healthy" >&2
    else
      echo "Previous signal bundle was restored but did not become healthy" >&2
    fi
  else
    # A first-time deployment has no known-good bundle to restore. Do not
    # leave the rejected candidate at the live path.
    rm -f "$live_bundle"
    systemctl stop yiqikan-signal.service >/dev/null 2>&1 || true
    echo "No previous signal bundle was available; service left stopped" >&2
  fi
  systemctl --no-pager --full status yiqikan-signal.service >&2 || true
  journalctl -u yiqikan-signal.service -n 80 --no-pager >&2 || true
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  echo "deploy-signal-v3.sh must run as root" >&2
  exit 1
fi
if [ ! -f "$source_bundle" ]; then
  echo "signal bundle not found: $source_bundle" >&2
  exit 1
fi
if [ -n "${EXPECTED_SHA256:-}" ]; then
  actual_sha256="$(sha256sum "$source_bundle" | awk '{print $1}')"
  if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
    echo "signal bundle SHA-256 mismatch" >&2
    exit 1
  fi
fi

node --check "$source_bundle"
# Do not mutate an existing working directory's access bits: the service may
# run through systemd DynamicUser and needs the existing traversal policy.
mkdir -p "$install_root" "$release_root"
install -o "$install_uid" -g "$install_gid" -m "$install_mode" "$source_bundle" "$candidate"
if [ -f "$live_bundle" ]; then
  install -o "$install_uid" -g "$install_gid" -m "$install_mode" "$live_bundle" "$backup"
fi

# mv is atomic because candidate and live bundle share the same filesystem.
mv -f "$candidate" "$live_bundle"
if ! systemctl restart yiqikan-signal.service; then
  rollback "v3 service restart failed"
fi

healthy=false
if wait_for_health "capabilities" 3; then
  healthy=true
fi

if [ "$healthy" != true ]; then
  rollback "v3 health check failed"
fi

systemctl is-active --quiet yiqikan-signal.service
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
printf '\nDeployed signal protocol v3; backup: %s\n' "$backup"
