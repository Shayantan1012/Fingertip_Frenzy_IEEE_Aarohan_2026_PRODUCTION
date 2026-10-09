#!/usr/bin/env bash
# Exercise release switches and failure recovery with fake Docker/curl, no EC2.
set -Eeuo pipefail
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
export TRACE="$TEST_ROOT/trace"
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/releases/first" "$TEST_ROOT/releases/second"
printf 'DOMAIN=games.example.com\n' > "$TEST_ROOT/.env"
for release in first second; do
  sed "s|ROOT=/opt/fingertip-frenzy|ROOT=$TEST_ROOT|" deploy/deploy.sh > "$TEST_ROOT/releases/$release/deploy.sh"
  printf 'ghcr.io/example/%s@sha256:%064d\n' "$release" 0 > "$TEST_ROOT/releases/$release/image.txt"
  touch "$TEST_ROOT/releases/$release/compose.yaml"
done
cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
echo "$APP_IMAGE $*" >> "$TRACE"
if [[ "$*" == *'config --format json'* ]]; then
  echo '{"services":{"caddy":{"environment":{"DOMAIN":"games.example.com"}}}}'
fi
if [[ "${FAIL_PREFLIGHT:-}" == 1 && "$*" == *'check-database.mjs'* ]]; then exit 1; fi
if [[ "${FAIL_SECOND:-}" == 1 && "$APP_IMAGE" == *'/second@'* && "$*" == *'up -d'* ]]; then exit 1; fi
MOCK
printf '#!/usr/bin/env bash\nexit 0\n' > "$TEST_ROOT/bin/curl"
chmod +x "$TEST_ROOT/bin/docker" "$TEST_ROOT/bin/curl"
export PATH="$TEST_ROOT/bin:$PATH"

bash "$TEST_ROOT/releases/first/deploy.sh"
[[ $(readlink -f "$TEST_ROOT/current") == "$TEST_ROOT/releases/first" ]]
[[ ! -e "$TEST_ROOT/previous" && ! -L "$TEST_ROOT/previous" ]]
echo 'PASS: first deployment creates current without a fake previous release'

truncate -s 0 "$TRACE"
if FAIL_SECOND=1 bash "$TEST_ROOT/releases/second/deploy.sh"; then exit 1; fi
[[ $(readlink -f "$TEST_ROOT/current") == "$TEST_ROOT/releases/first" ]]
grep -q 'example/first@.*up -d' "$TRACE"
echo 'PASS: failed replacement restores previous containers and retains current'

truncate -s 0 "$TRACE"
if FAIL_PREFLIGHT=1 bash "$TEST_ROOT/releases/second/deploy.sh"; then exit 1; fi
if grep -q 'up -d' "$TRACE"; then exit 1; fi
echo 'PASS: preflight failure never replaces or restarts active containers'

bash "$TEST_ROOT/releases/second/deploy.sh"
[[ $(readlink -f "$TEST_ROOT/current") == "$TEST_ROOT/releases/second" ]]
[[ $(readlink -f "$TEST_ROOT/previous") == "$TEST_ROOT/releases/first" ]]
bash "$TEST_ROOT/previous/deploy.sh"
[[ $(readlink -f "$TEST_ROOT/current") == "$TEST_ROOT/releases/first" ]]
echo 'PASS: successful release and manual rollback resolve physical release paths'
