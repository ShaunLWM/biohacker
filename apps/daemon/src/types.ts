import type {
	LabTemplateId,
	VmRecord,
	VmSecret,
	VmTerminationReason,
} from "@biohacker/shared";

export interface VmReservation {
	id: string;
	templateId: LabTemplateId;
	sshPort: number;
	createdAt: string;
	expiresAt: string;
}

export interface MockRuntime {
	kind: "mock";
}

export interface FirecrackerRuntime {
	kind: "firecracker";
	id: string;
	templateId: LabTemplateId;
	username: string;
	createdAt: string;
	expiresAt: string;
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
	stdoutLogPath: string;
	stderrLogPath: string;
	metadataPath: string;
}

export type VmRuntime = MockRuntime | FirecrackerRuntime;

export interface ManagedVm {
	record: VmRecord;
	runtime: VmRuntime;
}

export interface VmCreationResult {
	instance: ManagedVm;
	launchInstructions: string[];
	secret: VmSecret;
}

export interface VmRunner {
	create(reservation: VmReservation): Promise<VmCreationResult>;
	shutdown(instance: ManagedVm, reason: VmTerminationReason): Promise<void>;
	reconcile(): Promise<ManagedVm[]>;
}
