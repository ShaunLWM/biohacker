#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
APP_DIR="${APP_DIR:-/opt/biohacker/app}"
SERVICE_NAME="${SERVICE_NAME:-biohacker-daemon}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run server.sh as root." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/compose.yml" ]]; then
  echo "Expected app repo at $APP_DIR" >&2
  exit 1
fi

compose() {
  docker compose -f "$APP_DIR/compose.yml" --project-directory "$APP_DIR" "$@"
}

build_daemon() {
  pnpm --dir "$APP_DIR/apps/daemon" build
}

ensure_daemon_build() {
  if [[ ! -f "$APP_DIR/apps/daemon/dist/index.js" ]]; then
    build_daemon
  fi
}

case "$ACTION" in
  start|resume)
    ensure_daemon_build
    systemctl enable --now "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
    compose up -d
    ;;
  stop|pause)
    systemctl stop "$SERVICE_NAME"
    compose down
    ;;
  restart|rebuild)
    build_daemon
    compose up -d --build
    systemctl restart "$SERVICE_NAME"
    ;;
  status)
    compose ps
    systemctl status "$SERVICE_NAME" --no-pager
    ;;
  logs)
    journalctl -u "$SERVICE_NAME" -n 150 --no-pager
    echo
    compose logs --tail=150 web postgres
    ;;
  *)
    cat <<'EOF' >&2
Usage:
  server.sh start
  server.sh stop
  server.sh restart
  server.sh rebuild
  server.sh status
  server.sh logs
  server.sh pause
  server.sh resume
EOF
    exit 1
    ;;
esac
