#!/usr/bin/env bash
set -euo pipefail

REPO_API="https://api.github.com/repos/firecracker-microvm/firecracker/releases"
INSTALL_DIR="${FIRECRACKER_INSTALL_DIR:-/opt/biohacker/firecracker}"
REQUESTED_VERSION="${FIRECRACKER_VERSION:-latest}"
TMP_DIR="$(mktemp -d)"
ARCH="$(uname -m)"

cleanup() {
	rm -rf "$TMP_DIR"
}

trap cleanup EXIT

case "$ARCH" in
  x86_64|amd64)
    ASSET_ARCH="x86_64"
    ;;
  aarch64|arm64)
    ASSET_ARCH="aarch64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

if [[ "$REQUESTED_VERSION" == "latest" ]]; then
  RELEASE_URL="$REPO_API/latest"
else
  RELEASE_URL="$REPO_API/tags/$REQUESTED_VERSION"
fi

echo "Fetching Firecracker release metadata from $RELEASE_URL"
curl -fsSL "$RELEASE_URL" -o "$TMP_DIR/release.json"

RESOLVED_VERSION="$(jq -r '.tag_name' "$TMP_DIR/release.json")"
ASSET_URL="$(jq -r --arg arch "$ASSET_ARCH" '
  .assets[]
  | select(.name | test($arch) and endswith(".tgz"))
  | .browser_download_url
' "$TMP_DIR/release.json" | head -n 1)"

if [[ -z "$ASSET_URL" ]]; then
  echo "Unable to find a Firecracker tarball for architecture $ASSET_ARCH in release $RESOLVED_VERSION" >&2
  exit 1
fi

echo "Downloading $RESOLVED_VERSION from $ASSET_URL"
curl -fL "$ASSET_URL" -o "$TMP_DIR/firecracker.tgz"
mkdir -p "$TMP_DIR/extract"
tar -xzf "$TMP_DIR/firecracker.tgz" -C "$TMP_DIR/extract"

FIRECRACKER_BIN_PATH="$(find "$TMP_DIR/extract" -type f -name firecracker | head -n 1)"
JAILER_BIN_PATH="$(find "$TMP_DIR/extract" -type f -name jailer | head -n 1)"

if [[ -z "$FIRECRACKER_BIN_PATH" || -z "$JAILER_BIN_PATH" ]]; then
  echo "Failed to locate firecracker and jailer binaries in the downloaded archive" >&2
  exit 1
fi

install -d "$INSTALL_DIR"
install -m 0755 "$FIRECRACKER_BIN_PATH" "$INSTALL_DIR/firecracker"
install -m 0755 "$JAILER_BIN_PATH" "$INSTALL_DIR/jailer"
printf '%s\n' "$RESOLVED_VERSION" > "$INSTALL_DIR/VERSION"

echo "Installed Firecracker $RESOLVED_VERSION to $INSTALL_DIR"
