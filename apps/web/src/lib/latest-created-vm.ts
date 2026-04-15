import type { CreateVmResponse, VmRecord } from "@biohacker/shared";

export function reconcileLatestCreatedVm(
	latestCreatedVm: CreateVmResponse | null,
	activeVms: readonly VmRecord[],
	vmListUpdatedAt: number,
	vmListBaselineAt: number,
) {
	if (!latestCreatedVm) {
		return null;
	}

	// Ignore the list snapshot that existed before this VM was created.
	if (vmListUpdatedAt <= vmListBaselineAt) {
		return latestCreatedVm;
	}

	return activeVms.some((vm) => vm.id === latestCreatedVm.id)
		? latestCreatedVm
		: null;
}
