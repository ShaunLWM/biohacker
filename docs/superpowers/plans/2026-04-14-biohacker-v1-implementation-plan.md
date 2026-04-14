# Biohacker v1 Implementation Plan

Date: 2026-04-14
Based on: `docs/superpowers/specs/2026-04-14-biohacker-v1-design.md`

## Delivery Strategy

Build the project in vertical slices that keep the host-runtime work honest:

1. establish the repo and shared contracts
2. scaffold the web app with the official TanStack CLI
3. stand up the daemon as a plain HTTP control plane
4. add host bootstrap and Firecracker asset preparation
5. wire real VM lifecycle and networking
6. connect the frontend to live daemon APIs
7. verify end to end on Ubuntu 24.04 bare metal

The critical path is the host-level daemon plus Firecracker lifecycle. The database and auth scaffolding from the TanStack template are secondary and should not block VM delivery.

## Phase 1: Monorepo Foundation

### Tasks

- initialize a new pnpm workspace at `biohacker/`
- create:
  - `apps/web`
  - `apps/daemon`
  - `packages/shared`
- add root workspace config:
  - `pnpm-workspace.yaml`
  - root `package.json`
  - root `tsconfig` strategy
  - shared Biome config if the scaffold does not already cover it adequately
- add `.gitignore` including:
  - node modules
  - build outputs
  - environment files
  - `.superpowers/`

### Deliverables

- reproducible pnpm monorepo layout
- root scripts for install, dev, build, lint, and typecheck

### Acceptance Criteria

- `pnpm install` succeeds from repo root
- workspace packages resolve correctly

## Phase 2: Frontend Scaffold

### Tasks

- run the current TanStack CLI into `apps/web` using:
  - deployment: `nitro`
  - toolchain: `biome`
  - add-ons: `better-auth`, `drizzle`, `tanstack-query`
- confirm the generated app starts locally
- trim demo/example routes that are not useful for `biohacker`
- preserve generated Better Auth and Drizzle plumbing, but do not enable auth gates for v1

### Deliverables

- working TanStack Start app in `apps/web`
- clean baseline route structure for the VM control UI

### Acceptance Criteria

- web app boots in dev mode
- generated code typechecks
- auth is scaffolded but not required to reach the control page

## Phase 3: Shared Contracts

### Tasks

- create `packages/shared` for:
  - VM state enum
  - VM DTOs
  - create/shutdown response shapes
  - config schema and parsing helpers
- choose one validation approach and use it consistently across web and daemon

### Deliverables

- importable shared package used by both apps

### Acceptance Criteria

- web and daemon compile against the same API types
- no duplicated request/response types across apps

## Phase 4: Daemon Skeleton

### Tasks

- scaffold `apps/daemon` as a Node TypeScript service
- add:
  - config loader
  - health endpoint
  - `POST /v1/vms`
  - `GET /v1/vms`
  - `POST /v1/vms/:id/shutdown`
- implement in-memory VM registry first
- add structured logging and explicit error envelopes

### Deliverables

- runnable daemon with stubbed VM lifecycle

### Acceptance Criteria

- daemon starts locally
- endpoints return valid typed responses
- VM registry survives normal request flow within one daemon process

## Phase 5: Host Bootstrap And Assets

### Tasks

- add `scripts/bootstrap-host.sh`
- add `scripts/install-firecracker.sh`
- add `scripts/prepare-base-image.sh`
- add systemd unit template under `infra/systemd/`
- define host directories:
  - `/opt/biohacker/firecracker`
  - `/var/lib/biohacker/base-images`
  - `/var/lib/biohacker/instances`
  - `/var/log/biohacker`
- install packages needed for:
  - Firecracker runtime
  - raw disk handling
  - cloud-init seed generation
  - networking

### Deliverables

- repeatable host bootstrap scripts
- documented systemd unit for the daemon
- prepared base guest assets

### Acceptance Criteria

- Ubuntu 24.04 host script completes without manual patching
- Firecracker and `jailer` binaries are installed
- base kernel and guest image exist in expected paths

## Phase 6: Firecracker Lifecycle Integration

### Tasks

- implement per-VM working directory creation
- implement SSH keypair generation
- implement NoCloud seed generation with:
  - `user-data`
  - `meta-data`
  - `network-config`
- implement writable disk derivation from the immutable base image
- implement Firecracker launch through `jailer`
- implement Unix socket API configuration:
  - machine config
  - boot source
  - drives
  - network interface
  - instance start
- implement shutdown and forced cleanup

### Deliverables

- daemon can create and destroy real Firecracker VMs on the host

### Acceptance Criteria

- one VM can boot successfully
- SSH becomes reachable on the forwarded host port
- shutdown deletes sockets, temp files, keys, and writable disk

## Phase 7: Host Networking

### Tasks

- implement host interface detection or explicit config
- implement TAP device allocation and cleanup
- implement guest IP allocation
- implement host NAT/masquerade rules
- implement SSH port forwarding from host public IP to guest `:22`
- implement cleanup and reconciliation for stale TAP devices and rules

### Deliverables

- reusable networking module for the local host worker

### Acceptance Criteria

- VM has outbound network access if enabled
- SSH forwarding works using host public IP plus allocated port
- stale networking artifacts are removed after shutdown or failed boot

## Phase 8: TTL And Reconciliation

### Tasks

- add `VM_TTL_MINUTES`
- compute `expiresAt` at create time
- add background sweeper for expired VMs
- add daemon startup reconciliation for:
  - orphaned instance directories
  - stale API sockets
  - stale tap devices
  - stale forwarded ports

### Deliverables

- enforced instance expiry
- safer daemon restart behavior

### Acceptance Criteria

- expired VMs are terminated without user action
- restart reconciliation does not leave obvious resource leaks

## Phase 9: Frontend Control Surface

### Tasks

- replace scaffold demo UI with a dedicated VM control page
- add:
  - create button
  - active VM list
  - SSH detail display
  - TTL/expires-at display
  - shutdown button
- wire TanStack Query to daemon endpoints
- handle loading, create failure, and expired states clearly

### Deliverables

- usable single-screen VM control UI

### Acceptance Criteria

- user can create a VM from the browser
- user can see SSH details immediately
- user can manually shut the VM down
- expired VM state is reflected in the UI

## Phase 10: Compose And Operator Flow

### Tasks

- add root `docker-compose.yml` or `compose.yml`
- run web and generated PostgreSQL via Compose
- add bind mounts where persistence is needed for app services
- add helper script such as `scripts/up-host.sh` to:
  - start compose services
  - restart or start the host daemon

### Deliverables

- repeatable local and bare-metal operator flow

### Acceptance Criteria

- `docker compose up -d` starts containerized services cleanly
- helper script brings the whole stack up in the right order

## Phase 11: Testing And Verification

### Tasks

- add unit tests for:
  - config parsing
  - IP allocation
  - SSH port allocation
  - TTL computation
  - cleanup planning
- add integration tests for daemon create/shutdown with mocked process boundaries
- add a host smoke-test checklist for real Ubuntu 24.04 validation

### Deliverables

- automated coverage for non-KVM logic
- documented host verification flow

### Acceptance Criteria

- CI-friendly tests pass without `/dev/kvm`
- bare-metal smoke test proves:
  - VM boot
  - SSH login
  - manual shutdown cleanup
  - TTL expiry cleanup

## Recommended Execution Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8
9. Phase 9
10. Phase 10
11. Phase 11

## Risk Watchlist

- TanStack CLI generated structure may differ slightly from the currently verified flags.
- Ubuntu cloud image preparation may require conversion details to be refined during implementation.
- Host firewall tooling may differ between `iptables` and nftables-backed environments on Ubuntu 24.04.
- Firecracker guest boot timing may vary enough that SSH readiness checks need retries and bounded backoff.
- Public, unauthenticated access is not safe for a real internet-facing security lab without further hardening.

## First Implementation Slice

The first useful slice after planning should be:

1. monorepo setup
2. TanStack web scaffold
3. daemon skeleton with stubbed API
4. shared types
5. compose for web plus postgres

That gives a running control-plane shell before touching KVM, host networking, or Firecracker process management.
