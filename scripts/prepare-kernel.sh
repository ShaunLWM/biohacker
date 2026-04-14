#!/usr/bin/env bash
set -euo pipefail

RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
OUTPUT_DIR="${FIRECRACKER_INSTALL_DIR:-/opt/biohacker/firecracker}"
KERNEL_OUTPUT_PATH="${KERNEL_OUTPUT_PATH:-$OUTPUT_DIR/vmlinux.bin}"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    FIRECRACKER_ARCH="x86_64"
    ;;
  aarch64|arm64)
    FIRECRACKER_ARCH="aarch64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

LATEST_VERSION="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASE_URL}/latest")")"
CI_VERSION="${LATEST_VERSION%.*}"
# Firecracker's own docs use plain HTTP for the S3 bucket listing endpoint.
# The HTTPS hostname often fails certificate validation on this bucket alias,
# while the actual kernel object download works over HTTPS via s3.amazonaws.com.
KERNEL_LIST_URL="http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/${FIRECRACKER_ARCH}/vmlinux-&list-type=2"

echo "Resolving Firecracker CI kernel for ${CI_VERSION} (${FIRECRACKER_ARCH})"

KERNEL_KEY="$(curl -fsSL "$KERNEL_LIST_URL" \
  | grep -oE "firecracker-ci/${CI_VERSION}/${FIRECRACKER_ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3}" \
  | sort -V \
  | tail -n 1)"

if [[ -z "$KERNEL_KEY" ]]; then
  echo "Failed to resolve a Firecracker CI kernel key for ${CI_VERSION}/${FIRECRACKER_ARCH}" >&2
  exit 1
fi

install -d "$OUTPUT_DIR"
curl -fL "https://s3.amazonaws.com/spec.ccfc.min/${KERNEL_KEY}" -o "$KERNEL_OUTPUT_PATH"

echo "Downloaded kernel to $KERNEL_OUTPUT_PATH"
