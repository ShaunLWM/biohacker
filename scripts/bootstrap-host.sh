#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root on the Ubuntu 24.04 host." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

apt-get update
apt-get install -y \
  ca-certificates \
  cloud-image-utils \
  curl \
  e2fsprogs \
  iproute2 \
  iptables \
  jq \
  nftables \
  openssh-client \
  qemu-utils \
  xz-utils

if ! id -u biohacker >/dev/null 2>&1; then
  useradd --system --home /var/lib/biohacker --shell /usr/sbin/nologin biohacker
fi

install -d -o biohacker -g biohacker /var/lib/biohacker
install -d -o biohacker -g biohacker /var/lib/biohacker/base-images
install -d -o biohacker -g biohacker /var/lib/biohacker/instances
install -d -o biohacker -g biohacker /var/log/biohacker
install -d -m 0755 /opt/biohacker/firecracker
install -d -m 0755 /etc/biohacker

"$PROJECT_DIR/scripts/install-firecracker.sh"
"$PROJECT_DIR/scripts/prepare-kernel.sh"
"$PROJECT_DIR/scripts/prepare-base-image.sh"

cat >/etc/sysctl.d/99-biohacker.conf <<'EOF'
net.ipv4.ip_forward=1
EOF

sysctl --system

install -m 0644 \
  "$PROJECT_DIR/infra/systemd/biohacker-daemon.service" \
  /etc/systemd/system/biohacker-daemon.service

systemctl daemon-reload

cat >/etc/biohacker/daemon.env <<'EOF'
DAEMON_HOST=0.0.0.0
DAEMON_PORT=4000
RUNNER_MODE=firecracker
VM_TTL_MINUTES=60
MAX_ACTIVE_VMS=10
VM_VCPU_COUNT=2
VM_MEMORY_MIB=2048
SSH_BOOT_TIMEOUT_MS=120000
HOST_PUBLIC_IP=127.0.0.1
HOST_INTERFACE=eth0
GUEST_NETWORK_BASE=172.29.0.0
SSH_PORT_RANGE_START=2200
SSH_PORT_RANGE_END=2299
INSTANCE_BASE_DIR=/var/lib/biohacker/instances
BASE_IMAGE_PATH=/var/lib/biohacker/base-images/ubuntu-24.04.raw
KERNEL_IMAGE_PATH=/opt/biohacker/firecracker/vmlinux.bin
FIRECRACKER_BIN=/opt/biohacker/firecracker/firecracker
JAILER_BIN=/opt/biohacker/firecracker/jailer
EOF

cat <<'EOF'
Host bootstrap complete.

Next steps:
1. Build the daemon: pnpm --dir apps/daemon build
2. Copy the repo to /opt/biohacker/app or update the systemd WorkingDirectory/ExecStart paths.
3. Set /etc/biohacker/daemon.env with the real host IP, host interface, kernel image path, and runner mode.
4. Enable the service: systemctl enable --now biohacker-daemon
5. Start web and postgres: docker compose up -d
EOF
