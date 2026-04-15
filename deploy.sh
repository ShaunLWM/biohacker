#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
PUBLIC_IP="${2:-}"
BRANCH="${3:-main}"
APP_DIR="${APP_DIR:-/opt/biohacker/app}"
APP_PARENT="$(dirname "$APP_DIR")"

usage() {
  cat <<'EOF'
Usage:
  deploy.sh <github-url> <public-ip> [branch]

Example:
  deploy.sh https://github.com/you/biohacker.git 203.0.113.10
EOF
}

require_arg() {
  local value="$1"
  local name="$2"

  if [[ -z "$value" ]]; then
    echo "Missing required argument: $name" >&2
    usage
    exit 1
  fi
}

env_value() {
  local file="$1"
  local key="$2"
  local fallback="$3"

  if [[ -f "$file" ]]; then
    local current
    current="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d '=' -f 2- || true)"
    if [[ -n "$current" ]]; then
      printf '%s\n' "$current"
      return
    fi
  fi

  printf '%s\n' "$fallback"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  local arch
  arch="$(dpkg --print-architecture)"
  cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable
EOF

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

version_gte() {
  local left="$1"
  local right="$2"
  local IFS=.
  local left_major left_minor left_patch
  local right_major right_minor right_patch

  read -r left_major left_minor left_patch <<<"$left"
  read -r right_major right_minor right_patch <<<"$right"

  left_major="${left_major:-0}"
  left_minor="${left_minor:-0}"
  left_patch="${left_patch:-0}"
  right_major="${right_major:-0}"
  right_minor="${right_minor:-0}"
  right_patch="${right_patch:-0}"

  if (( 10#$left_major > 10#$right_major )); then
    return 0
  fi

  if (( 10#$left_major < 10#$right_major )); then
    return 1
  fi

  if (( 10#$left_minor > 10#$right_minor )); then
    return 0
  fi

  if (( 10#$left_minor < 10#$right_minor )); then
    return 1
  fi

  (( 10#$left_patch >= 10#$right_patch ))
}

node_version_satisfies_repo() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  local raw_version version major
  raw_version="$(node --version 2>/dev/null || true)"
  version="${raw_version#v}"

  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    return 1
  fi

  major="${version%%.*}"

  if (( 10#$major >= 22 )); then
    version_gte "$version" "22.12.0"
    return $?
  fi

  if (( 10#$major == 20 )); then
    version_gte "$version" "20.19.0"
    return $?
  fi

  return 1
}

install_node() {
  if command -v corepack >/dev/null 2>&1 && node_version_satisfies_repo; then
    return
  fi

  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
}

sync_repo() {
  install -d -m 0755 "$APP_PARENT"

  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --tags origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
    return
  fi

  if [[ -e "$APP_DIR" ]]; then
    echo "Refusing to replace existing non-git path: $APP_DIR" >&2
    exit 1
  fi

  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
}

write_compose_env() {
  local env_file="$APP_DIR/.env"
  local better_auth_secret
  better_auth_secret="$(env_value "$env_file" "BETTER_AUTH_SECRET" "$(cat /proc/sys/kernel/random/uuid)$(cat /proc/sys/kernel/random/uuid)")"

  cat >"$env_file" <<EOF
BETTER_AUTH_URL=http://${PUBLIC_IP}:3000
BETTER_AUTH_SECRET=${better_auth_secret}
DATABASE_URL=postgresql://biohacker:biohacker@postgres:5432/biohacker
DAEMON_INTERNAL_URL=http://host.docker.internal:4000
WEB_PORT=3000
POSTGRES_DB=biohacker
POSTGRES_USER=biohacker
POSTGRES_PASSWORD=biohacker
EOF
}

write_daemon_env() {
  local daemon_env="/etc/biohacker/daemon.env"
  local host_interface
  local vm_ttl_minutes
  local max_active_vms
  local vm_vcpu_count
  local vm_memory_mib
  local ssh_boot_timeout_ms
  local preserve_failed_vm_state
  local guest_network_base
  local ssh_port_range_start
  local ssh_port_range_end
  host_interface="$(ip route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"

  if [[ -z "$host_interface" ]]; then
    echo "Failed to detect host interface." >&2
    exit 1
  fi

  vm_ttl_minutes="$(env_value "$daemon_env" "VM_TTL_MINUTES" "60")"
  max_active_vms="$(env_value "$daemon_env" "MAX_ACTIVE_VMS" "10")"
  vm_vcpu_count="$(env_value "$daemon_env" "VM_VCPU_COUNT" "2")"
  vm_memory_mib="$(env_value "$daemon_env" "VM_MEMORY_MIB" "2048")"
  ssh_boot_timeout_ms="$(env_value "$daemon_env" "SSH_BOOT_TIMEOUT_MS" "120000")"
  preserve_failed_vm_state="$(env_value "$daemon_env" "PRESERVE_FAILED_VM_STATE" "false")"
  guest_network_base="$(env_value "$daemon_env" "GUEST_NETWORK_BASE" "172.29.0.0")"
  ssh_port_range_start="$(env_value "$daemon_env" "SSH_PORT_RANGE_START" "2200")"
  ssh_port_range_end="$(env_value "$daemon_env" "SSH_PORT_RANGE_END" "2299")"

  cat >"$daemon_env" <<EOF
DAEMON_HOST=0.0.0.0
DAEMON_PORT=4000
RUNNER_MODE=firecracker
VM_TTL_MINUTES=${vm_ttl_minutes}
MAX_ACTIVE_VMS=${max_active_vms}
VM_VCPU_COUNT=${vm_vcpu_count}
VM_MEMORY_MIB=${vm_memory_mib}
SSH_BOOT_TIMEOUT_MS=${ssh_boot_timeout_ms}
PRESERVE_FAILED_VM_STATE=${preserve_failed_vm_state}
HOST_PUBLIC_IP=${PUBLIC_IP}
HOST_INTERFACE=${host_interface}
GUEST_NETWORK_BASE=${guest_network_base}
SSH_PORT_RANGE_START=${ssh_port_range_start}
SSH_PORT_RANGE_END=${ssh_port_range_end}
INSTANCE_BASE_DIR=/var/lib/biohacker/instances
BASE_IMAGE_PATH=/var/lib/biohacker/base-images/ubuntu-24.04.raw
KERNEL_IMAGE_PATH=/opt/biohacker/firecracker/vmlinux.bin
FIRECRACKER_BIN=/opt/biohacker/firecracker/firecracker
JAILER_BIN=/opt/biohacker/firecracker/jailer
EOF
}

main() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Run deploy.sh as root." >&2
    exit 1
  fi

  require_arg "$REPO_URL" "github-url"
  require_arg "$PUBLIC_IP" "public-ip"

  apt-get update
  apt-get install -y ca-certificates curl git gnupg jq
  install_docker
  install_node
  corepack enable
  corepack prepare pnpm@10.12.4 --activate

  sync_repo

  cd "$APP_DIR"
  pnpm install
  pnpm build

  "$APP_DIR/scripts/bootstrap-host.sh"
  write_compose_env
  write_daemon_env

  systemctl daemon-reload
  systemctl enable --now biohacker-daemon
  systemctl restart biohacker-daemon

  docker compose up -d --build

  cat <<EOF
Deployment complete.

Web:
  http://${PUBLIC_IP}:3000

Daemon health:
  http://${PUBLIC_IP}:4000/health

Management:
  cd ${APP_DIR}
  ./server.sh status
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
