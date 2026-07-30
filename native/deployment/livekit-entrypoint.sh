#!/bin/sh
set -eu

api_key="${LIVEKIT_API_KEY:-}"
secret_file="${LIVEKIT_API_SECRET_FILE:-/run/secrets/livekit_api_secret}"
livekit_binary="${LIVEKIT_BINARY:-/livekit-server}"
node_ip="${LIVEKIT_NODE_IP:-}"
turn_host="${LIVEKIT_TURN_HOST:-}"
turn_secret_file="${TURN_SECRET_FILE:-}"
turn_ttl="${TURN_CREDENTIAL_TTL_SECONDS:-2700}"
runtime_config="/tmp/synced-livekit.yaml"

if [ ! -x "$livekit_binary" ]; then
  echo "LiveKit server binary is missing or not executable: $livekit_binary" >&2
  exit 1
fi
case "$api_key" in
  *[!A-Za-z0-9_-]*|"")
    echo "LIVEKIT_API_KEY must use only letters, digits, underscore, or dash" >&2
    exit 1
    ;;
esac
if [ ! -r "$secret_file" ]; then
  echo "LiveKit API secret file is missing or unreadable: $secret_file" >&2
  exit 1
fi
api_secret="$(tr -d '\r\n' < "$secret_file")"
case "$api_secret" in
  *[!A-Za-z0-9_-]*|"")
    echo "LiveKit API secret must use URL-safe characters" >&2
    exit 1
    ;;
esac
if [ "${#api_secret}" -lt 32 ]; then
  echo "LiveKit API secret must contain at least 32 characters" >&2
  exit 1
fi
if [ -n "$node_ip" ]; then
  case "$node_ip" in
    *[!0-9a-fA-F:.]*)
      echo "LIVEKIT_NODE_IP is not a valid literal IP address" >&2
      exit 1
      ;;
  esac
fi
if [ -n "$turn_host" ] && [ ! -r "$turn_secret_file" ]; then
  echo "TURN secret file is missing or unreadable: $turn_secret_file" >&2
  exit 1
fi
case "$turn_ttl" in
  *[!0-9]*|"")
    echo "TURN_CREDENTIAL_TTL_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac

umask 077
{
  printf 'port: 7880\n'
  printf 'log_level: info\n'
  printf 'rtc:\n'
  printf '  tcp_port: 7881\n'
  printf '  udp_port: 7882\n'
  if [ -n "$node_ip" ]; then
    printf '  use_external_ip: false\n'
    printf '  node_ip: "%s"\n' "$node_ip"
  else
    printf '  use_external_ip: true\n'
  fi
  printf '  enable_loopback_candidate: false\n'
  printf '  data_channel_max_buffered_amount: 0\n'
  printf '  datachannel_data_track_target_latency: 0s\n'
  if [ -n "$turn_host" ]; then
    printf '  turn_servers:\n'
    printf '    - host: "%s"\n' "$turn_host"
    printf '      port: 3478\n'
    printf '      protocol: udp\n'
    printf '      secret_file: "%s"\n' "$turn_secret_file"
    printf '      ttl: %s\n' "$turn_ttl"
    printf '    - host: "%s"\n' "$turn_host"
    printf '      port: 3478\n'
    printf '      protocol: tcp\n'
    printf '      secret_file: "%s"\n' "$turn_secret_file"
    printf '      ttl: %s\n' "$turn_ttl"
  fi
  printf 'keys:\n'
  printf '  %s: %s\n' "$api_key" "$api_secret"
  printf 'room:\n'
  printf '  auto_create: true\n'
  printf 'limit:\n'
  printf '  num_tracks: -1\n'
  printf '  bytes_per_sec: -1\n'
  printf '  subscription_limit_video: 0\n'
  printf '  subscription_limit_audio: 0\n'
  printf 'prometheus:\n'
  printf '  port: 6789\n'
} > "$runtime_config"
unset api_secret

# No bandwidth ceiling is configured. LiveKit can use all capacity available
# to the host, while congestion control remains end-to-end.
exec "$livekit_binary" --config "$runtime_config"
