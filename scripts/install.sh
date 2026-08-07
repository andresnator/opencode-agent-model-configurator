#!/bin/sh

set -eu

REPOSITORY_URL="${MODELS_PRESETS_REPOSITORY_URL:-https://github.com/andresnator/opencode-agent-model-configurator.git}"
DEFAULT_INSTALL_DIR="/tmp/opencode-models-presets"
INSTALL_DIR="${MODELS_PRESETS_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
REQUESTED_VERSION="${1:-latest}"

usage() {
  printf '%s\n' "Usage: install.sh [latest|vX.Y.Z|X.Y.Z]"
}

fail() {
  printf 'models-presets installer: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

resolve_latest_tag() {
  git ls-remote --refs --sort='-version:refname' --tags "$REPOSITORY_URL" 'v[0-9]*' |
    awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { sub("refs/tags/", "", $2); print $2; exit }'
}

case "$REQUESTED_VERSION" in
  -h|--help)
    usage
    exit 0
    ;;
esac

[ "$#" -le 1 ] || {
  usage >&2
  exit 1
}

require_command git
require_command awk
require_command grep
require_command opencode

case "$INSTALL_DIR" in
  /*) ;;
  *) fail "MODELS_PRESETS_INSTALL_DIR must be an absolute path" ;;
esac

if [ "$REQUESTED_VERSION" = "latest" ]; then
  RELEASE_TAG="$(resolve_latest_tag)"
  [ -n "$RELEASE_TAG" ] || fail "no published vX.Y.Z release tags were found"
else
  case "$REQUESTED_VERSION" in
    v*) RELEASE_TAG="$REQUESTED_VERSION" ;;
    *) RELEASE_TAG="v$REQUESTED_VERSION" ;;
  esac
fi

printf '%s\n' "$RELEASE_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' ||
  fail "version must be latest or a stable vX.Y.Z release"

git ls-remote --exit-code --refs --tags "$REPOSITORY_URL" "refs/tags/$RELEASE_TAG" >/dev/null 2>&1 ||
  fail "release tag does not exist: $RELEASE_TAG"

umask 077
if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
  [ ! -L "$INSTALL_DIR" ] || fail "refusing to use a symbolic-link install directory: $INSTALL_DIR"
  [ -d "$INSTALL_DIR/.git" ] || fail "install directory exists but is not a Git checkout: $INSTALL_DIR"
  ORIGIN_URL="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  [ "$ORIGIN_URL" = "$REPOSITORY_URL" ] || fail "install directory belongs to a different repository: $INSTALL_DIR"
  [ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=all)" ] ||
    fail "install checkout has local changes; preserve them or choose another MODELS_PRESETS_INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
  git -C "$INSTALL_DIR" checkout --detach "$RELEASE_TAG"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$RELEASE_TAG" --depth 1 --single-branch "$REPOSITORY_URL" "$INSTALL_DIR"
fi

EXPECTED_COMMIT="$(git -C "$INSTALL_DIR" rev-parse "$RELEASE_TAG^{commit}")"
ACTUAL_COMMIT="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
[ "$ACTUAL_COMMIT" = "$EXPECTED_COMMIT" ] || fail "checkout does not match $RELEASE_TAG"

opencode plugin "$INSTALL_DIR" --global --force

printf '%s\n' "Installed models-presets $RELEASE_TAG from $INSTALL_DIR."
printf '%s\n' "Keep that directory in place, restart OpenCode, and use the entry point documented for $RELEASE_TAG."
