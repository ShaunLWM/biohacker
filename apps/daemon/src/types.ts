import type { VmRecord, VmTerminationReason } from "@biohacker/shared";

export interface VmReservation {
	id: string;
	sshPort: number;
	createdAt: string;
	expiresAt: string;
}

export interface MockRuntime {
	kind: "mock";
}

export interface FirecrackerRuntime {
	kind: "firecracker";
	sshPort: number;
	instanceDir: string;
	apiSocketPath: string;
	firecrackerPid: number;
	tapName: string;
	subnetCidr: string;
	hostTapIp: string;
	guestIp: string;
	guestMac: string;
	writableRootfsPath: string;
	seedImagePath: string;
	sshPrivateKeyPath: string;
	sshPublicKeyPath: string;
	userDataPath: string;
	metaDataPath: string;
	networkConfigPath: string;
	stdoutLogPath: string;
	stderrLogPath: string;
	metadataPath: string;
}

export type VmRuntime = MockRuntime | FirecrackerRuntime;

export interface ManagedVm {
	record: VmRecord;
	runtime: VmRuntime;
}

export interface VmRunner {
	create(reservation: VmReservation): Promise<ManagedVm>;
	shutdown(instance: ManagedVm, reason: VmTerminationReason): Promise<void>;
	reconcile(): Promise<void>;
}
