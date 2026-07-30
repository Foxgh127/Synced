#!/bin/sh
set -eu

secret_file="${TURN_SECRET_FILE:-/run/secrets/turn_secret}"
runtime_config="/tmp/synced-turnserver.conf"

if [ ! -r "$secret_file" ]; then
  echo "TURN secret file is missing or unreadable: $secret_file" >&2
  exit 1
fi

secret="$(tr -d '\r\n' < "$secret_file")"
if [ "${#secret}" -lt 32 ]; then
  echo "TURN secret must contain at least 32 characters" >&2
  exit 1
fi

umask 077
{
  echo "use-auth-secret"
  printf 'static-auth-secret=%s\n' "$secret"
} > "$runtime_config"
unset secret

# The secret lives only in a root-readable runtime config file. It is never
# expanded into coturn's argv or copied into the image.
exec turnserver -c "$runtime_config" "$@"
