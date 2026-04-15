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

case "$ACTION" in
  start|resume)
    systemctl enable --now "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
    compose up -d
    ;;
  stop|pause)
    systemctl stop "$SERVICE_NAME"
    compose down
    ;;
  restart)
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
  server.sh status
  server.sh logs
  server.sh pause
  server.sh resume
EOF
    exit 1
    ;;
esac
