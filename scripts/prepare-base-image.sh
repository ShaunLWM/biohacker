#!/usr/bin/env bash
set -euo pipefail

UBUNTU_RELEASE_BASE="https://cloud-images.ubuntu.com/releases/noble/release"
OUTPUT_DIR="${BASE_IMAGE_DIR:-/var/lib/biohacker/base-images}"
RAW_NAME="${BASE_IMAGE_NAME:-ubuntu-24.04.raw}"
DISK_SIZE_GB="${BASE_IMAGE_SIZE_GB:-12}"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    UBUNTU_ARCH="amd64"
    ;;
  aarch64|arm64)
    UBUNTU_ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

RAW_PATH="$OUTPUT_DIR/$RAW_NAME"
ROOTFS_URL="$UBUNTU_RELEASE_BASE/ubuntu-24.04-server-cloudimg-${UBUNTU_ARCH}-root.tar.xz"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

install -d "$OUTPUT_DIR"

echo "Downloading Ubuntu 24.04 root filesystem from $ROOTFS_URL"
curl -fL "$ROOTFS_URL" -o "$TMP_DIR/rootfs.tar.xz"

echo "Extracting Ubuntu root filesystem"
install -d "$TMP_DIR/rootfs"
tar -xJf "$TMP_DIR/rootfs.tar.xz" -C "$TMP_DIR/rootfs" --numeric-owner

echo "Creating ext4 rootfs image at $RAW_PATH"
rm -f "$RAW_PATH"
truncate -s "${DISK_SIZE_GB}G" "$RAW_PATH"
mkfs.ext4 -F -d "$TMP_DIR/rootfs" -L rootfs "$RAW_PATH"
tune2fs -m 0 "$RAW_PATH" >/dev/null

ls -lh "$RAW_PATH"
