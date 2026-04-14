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

QCOW_PATH="$OUTPUT_DIR/ubuntu-24.04-${UBUNTU_ARCH}.img"
RAW_PATH="$OUTPUT_DIR/$RAW_NAME"
IMAGE_URL="$UBUNTU_RELEASE_BASE/ubuntu-24.04-server-cloudimg-${UBUNTU_ARCH}.img"

install -d "$OUTPUT_DIR"

echo "Downloading Ubuntu 24.04 cloud image from $IMAGE_URL"
curl -fL "$IMAGE_URL" -o "$QCOW_PATH"

echo "Converting $QCOW_PATH to raw image $RAW_PATH"
qemu-img convert -f qcow2 -O raw "$QCOW_PATH" "$RAW_PATH"

echo "Resizing raw image to ${DISK_SIZE_GB}G"
qemu-img resize "$RAW_PATH" "${DISK_SIZE_GB}G"

qemu-img info "$RAW_PATH"
