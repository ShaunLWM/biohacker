# biohacker

`biohacker` is a small control plane for launching disposable Firecracker security labs from a web UI.

The project is aimed at security training workflows:

- choose a lab template in the browser
- click `Launch lab`
- the daemon boots a fresh Firecracker microVM on a bare-metal Ubuntu host
- the UI returns the SSH target and any one-time lab-specific instructions
- click `Shutdown` or wait for the TTL to expire
- the writable VM state is deleted immediately

The base image is kept. Individual instances are not.

The first bundled training package is:

- `weak-ssh`: a disposable Ubuntu target with password-only SSH enabled for the `student` account and an intentionally weak password that is not revealed by the control plane

## Architecture

This repo uses a `pnpm` monorepo with two apps:

- `apps/web`: TanStack Start frontend and server-side proxy routes
- `apps/daemon`: Node.js daemon that manages Firecracker VMs on the host

It is intentionally deployed in a hybrid model:

- `docker compose` runs the web app and PostgreSQL
- `systemd` runs the daemon directly on the host with access to `/dev/kvm`, TAP devices, and iptables

## What Works

The current goal is narrow and operational:

- launch a new Ubuntu lab VM from a named template
- return SSH target details to the frontend
- shut the VM down on demand
- auto-expire VMs after a configurable TTL
- remove instance state on shutdown

This is not a multi-tenant platform yet. Auth, persistence, and multi-host scheduling are intentionally thin or unfinished.

## Repo Layout

```text
apps/
  web/       TanStack Start app
  daemon/    Firecracker control daemon
packages/
  shared/    shared schemas and types
infra/
  systemd/   host service unit
scripts/
  bootstrap-host.sh
  install-firecracker.sh
  prepare-kernel.sh
  prepare-base-image.sh
compose.yml
```

## Host Requirements

The intended target is:

- Ubuntu 24.04 bare-metal server
- KVM available
- root access
- Docker + Compose plugin
- Node.js 24 + `pnpm`

This project is not meant to run Firecracker locally on macOS.

## Local Workspace Commands

From the repo root:

```bash
pnpm install
pnpm typecheck
pnpm build
```

Useful dev commands:

```bash
pnpm dev:web
pnpm dev:daemon
```

## Bare-Metal Deployment

The intended operator path is the wrapper script:

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy.sh -o deploy.sh
chmod +x deploy.sh
sudo ./deploy.sh https://github.com/<you>/biohacker.git <public-ip>
```

That script:

- installs Docker, Compose, Node.js, and `pnpm`
- clones or updates the repo in `/opt/biohacker/app`
- builds the workspace
- bootstraps Firecracker, the kernel, and the Ubuntu base image
- writes `.env` and `/etc/biohacker/daemon.env`
- starts Compose plus `biohacker-daemon`

If you want the lower-level manual path, use:

1. Clone the repo to `/opt/biohacker/app`
2. Install dependencies and build:

```bash
cd /opt/biohacker/app
pnpm install
pnpm build
```

3. Bootstrap the host:

```bash
sudo ./scripts/bootstrap-host.sh
```

This installs:

- Firecracker and `jailer`
- a Firecracker kernel
- the base Ubuntu rootfs image
- required host packages
- the `biohacker-daemon` systemd unit

4. Configure the daemon:

```bash
sudoedit /etc/biohacker/daemon.env
```

Important values:

- `RUNNER_MODE=firecracker`
- `HOST_PUBLIC_IP=<your server IP>`
- `HOST_INTERFACE=<your public NIC>`
- `VM_TTL_MINUTES=60`
- `MAX_ACTIVE_VMS=10`

5. Start the web stack:

```bash
docker compose up -d --build
```

6. Start the daemon:

```bash
sudo systemctl enable --now biohacker-daemon
sudo systemctl restart biohacker-daemon
```

## Runtime Flow

When a VM is created, the daemon:

1. allocates a VM id, guest subnet, and SSH port
2. clones the base rootfs into a per-instance writable image
3. injects guest SSH, weak-lab account config, and network config into the rootfs
4. creates a TAP device and host NAT rules
5. launches Firecracker and configures the microVM
6. waits for SSH to become reachable
7. returns `host`, `sshPort`, `username`, the selected template id, and any one-time lab instructions

For the bundled `weak-ssh` lab:

- the daemon creates a `student` user inside the guest rootfs if needed
- SSH password auth is enabled and public-key auth is disabled
- the weak password is intentionally not returned by the API or shown in the UI

On shutdown or TTL expiry, it:

1. stops the Firecracker process
2. removes NAT and forwarding rules
3. deletes the TAP device
4. deletes the instance directory

## Environment

Daemon settings live in:

- `apps/daemon/.env.example`
- `/etc/biohacker/daemon.env` on the host

Web settings live in:

- `apps/web/.env.example`
- `.env` at the repo root for Compose-based deployment

## Lab Templates

The web app and daemon already use a template contract so future packages can be added without redesigning the control plane.

Current template ids:

- `weak-ssh`

Each lab template controls:

- the displayed objective and summary in the UI
- how the guest rootfs is customized before boot
- what, if any, one-time secret or instructions are returned on creation

## Fresh Deployment

For a fresh Ubuntu 24.04 bare-metal server, the simplest path is:

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy.sh -o deploy.sh
chmod +x deploy.sh
sudo ./deploy.sh https://github.com/<you>/biohacker.git <public-ip>
```

After that:

```bash
sudo /opt/biohacker/app/server.sh status
sudo /opt/biohacker/app/server.sh restart
sudo /opt/biohacker/app/server.sh logs
```

The default product behavior after deployment is:

- open `http://<public-ip>:3000`
- choose the `weak-ssh` lab
- launch a disposable target
- work against `student@<public-ip>:<ssh-port>`
- shut it down or let TTL remove it

## Current Caveats

- the daemon currently runs as `root` because it needs KVM, TAP, mount, and iptables access
- PostgreSQL and Better Auth are scaffolded in the web app, but not central to the VM flow yet
- there is no production-grade multi-user isolation layer yet
- the Firecracker path has been validated on Ubuntu bare metal, not on macOS

## Verification

Useful checks on the host:

```bash
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/v1/vms
sudo systemctl status biohacker-daemon --no-pager
docker compose ps
```

If VM creation fails, inspect:

```bash
journalctl -u biohacker-daemon -f
ls -lah /var/lib/biohacker/instances
```

## Service Control

After deployment, manage the stack with:

```bash
sudo /opt/biohacker/app/server.sh status
sudo /opt/biohacker/app/server.sh restart
sudo /opt/biohacker/app/server.sh logs
```
