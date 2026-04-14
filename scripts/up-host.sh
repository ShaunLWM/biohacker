#!/usr/bin/env bash
set -euo pipefail

docker compose up -d
sudo systemctl restart biohacker-daemon
sudo systemctl --no-pager --full status biohacker-daemon
