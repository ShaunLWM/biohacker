import type { VmRecord } from "@biohacker/shared";

export function buildSshCommand(
	connection: Pick<VmRecord, "host" | "sshPort" | "username">,
) {
	return `ssh -p ${connection.sshPort} ${connection.username}@${connection.host}`;
}
