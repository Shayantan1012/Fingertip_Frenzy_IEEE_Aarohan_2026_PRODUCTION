#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=/opt/fingertip-frenzy
RELEASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ $EUID == 0 ]] || { echo 'Run as root (SSM runs as root).'; exit 1; }
[[ "$RELEASE" == "$ROOT"/releases/* ]] || { echo 'Invalid release directory'; exit 1; }
[[ -f "$ROOT/.env" && -f "$RELEASE/image.txt" ]] || { echo 'Missing server configuration or image'; exit 1; }
exec 9>"$ROOT/deploy.lock"
flock -w 5 9 || { echo 'Another deployment is active'; exit 1; }
chmod 600 "$ROOT/.env"
export APP_IMAGE
APP_IMAGE=$(cat "$RELEASE/image.txt")
[[ "$APP_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Expected immutable GHCR digest'; exit 1; }
previous=''
if [[ -L "$ROOT/current" ]]; then previous=$(readlink -f "$ROOT/current"); fi
changed=0
compose() { docker compose --project-name fingertip-frenzy --env-file "$ROOT/.env" -f "$RELEASE/compose.yaml" "$@"; }
rollback() {
  local status=$?
  trap - ERR
  if (( changed )) && [[ -n "$previous" && -f "$previous/image.txt" ]]; then
    echo 'Deployment failed; restoring previous release.'
    export APP_IMAGE
    APP_IMAGE=$(cat "$previous/image.txt")
    if docker compose --project-name fingertip-frenzy --env-file "$ROOT/.env" -f "$previous/compose.yaml" up -d --wait --wait-timeout 120; then
      echo 'Previous containers restored. Check HTTPS and database readiness.'
    else
      echo 'ROLLBACK FAILED: inspect docker compose ps and logs immediately.' >&2
    fi
  elif (( changed )); then
    echo 'First deployment failed; no previous release exists. Inspect containers and configuration.' >&2
  fi
  exit "$status"
}
trap rollback ERR
compose config --quiet
compose pull
compose run --rm --no-deps app node scripts/check-database.mjs
# Required unique/TTL indexes; this never deletes indexes or participant records.
compose run --rm --no-deps app node scripts/indexes.mjs
changed=1
compose up -d --wait --wait-timeout 150
domain=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["caddy"]["environment"]["DOMAIN"])')
curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --max-time 15 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/api/health/ready" >/dev/null
curl --fail --silent --show-error --max-time 15 --resolve "$domain:443:127.0.0.1" "https://$domain/login" >/dev/null
if [[ -n "$previous" && "$previous" != "$RELEASE" ]]; then
  ln -sfn "$previous" "$ROOT/previous"
fi
ln -sfn "$RELEASE" "$ROOT/current"
echo "Deployment healthy: $APP_IMAGE"
