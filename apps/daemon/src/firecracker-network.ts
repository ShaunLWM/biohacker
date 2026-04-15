import { runCommand } from "./command.js";

export type NetworkAllocation = {
	hostTapIp: string;
	guestIp: string;
	subnetCidr: string;
	guestMac: string;
};

function parseIpv4(value: string) {
	const parts = value.split(".").map((part) => Number(part));

	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
		throw new Error(`Invalid IPv4 address: ${value}`);
	}

	return (
		((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
	);
}

function formatIpv4(value: number) {
	return [
		(value >>> 24) & 255,
		(value >>> 16) & 255,
		(value >>> 8) & 255,
		value & 255,
	].join(".");
}

function guestMacFromIp(ip: string) {
	const [a, b, c, d] = ip.split(".").map((part) => Number(part));
	return [0x06, 0x00, a, b, c, d]
		.map((part) => part.toString(16).padStart(2, "0"))
		.join(":");
}

export function allocateNetwork(
	guestNetworkBase: string,
	sshPortRangeStart: number,
	sshPort: number,
): NetworkAllocation {
	const base = parseIpv4(guestNetworkBase);
	const index = sshPort - sshPortRangeStart;
	const subnet = base + index * 4;
	const hostTapIp = formatIpv4(subnet + 1);
	const guestIp = formatIpv4(subnet + 2);
	const subnetCidr = `${formatIpv4(subnet)}/30`;
	const guestMac = guestMacFromIp(guestIp);

	return { hostTapIp, guestIp, subnetCidr, guestMac };
}

export async function configureTap(
	tapName: string,
	hostTapIp: string,
): Promise<void> {
	await runCommand("ip", ["tuntap", "add", "dev", tapName, "mode", "tap"]);
	await runCommand("ip", ["addr", "add", `${hostTapIp}/30`, "dev", tapName]);
	await runCommand("ip", ["link", "set", "dev", tapName, "up"]);
}

export async function configureIptables(
	tapName: string,
	hostInterface: string,
	hostPublicIp: string,
	subnetCidr: string,
	guestIp: string,
	sshPort: number,
): Promise<void> {
	// Allow replies for host-originated connections to the guest while still
	// blocking unsolicited guest-to-host traffic below.
	await runCommand("iptables", [
		"-I",
		"INPUT",
		"1",
		"-i",
		tapName,
		"-m",
		"state",
		"--state",
		"ESTABLISHED,RELATED",
		"-j",
		"ACCEPT",
	]);
	// Block all traffic from guest TAP interface to host services (1a)
	await runCommand("iptables", [
		"-I",
		"INPUT",
		"2",
		"-i",
		tapName,
		"-j",
		"DROP",
	]);
	// Block inter-TAP routing - VM can only forward to the physical NIC (1b)
	await runCommand("iptables", [
		"-I",
		"FORWARD",
		"-i",
		tapName,
		"!",
		"-o",
		hostInterface,
		"-j",
		"DROP",
	]);
	// Block cloud metadata endpoint (1c)
	await runCommand("iptables", [
		"-I",
		"FORWARD",
		"-s",
		subnetCidr,
		"-d",
		"169.254.169.254",
		"-j",
		"DROP",
	]);
	await runCommand("iptables", [
		"-t",
		"nat",
		"-I",
		"PREROUTING",
		"1",
		"-i",
		hostInterface,
		"-p",
		"tcp",
		"--dport",
		String(sshPort),
		"-j",
		"DNAT",
		"--to-destination",
		`${guestIp}:22`,
	]);
	await runCommand("iptables", [
		"-t",
		"nat",
		"-I",
		"OUTPUT",
		"1",
		"-d",
		hostPublicIp,
		"-p",
		"tcp",
		"--dport",
		String(sshPort),
		"-j",
		"DNAT",
		"--to-destination",
		`${guestIp}:22`,
	]);
	await runCommand("iptables", [
		"-t",
		"nat",
		"-I",
		"POSTROUTING",
		"1",
		"-s",
		subnetCidr,
		"-o",
		hostInterface,
		"-j",
		"MASQUERADE",
	]);
	// Allow only return traffic for established/related connections (1e)
	await runCommand("iptables", [
		"-I",
		"FORWARD",
		"3",
		"-i",
		tapName,
		"-o",
		hostInterface,
		"-m",
		"state",
		"--state",
		"ESTABLISHED,RELATED",
		"-j",
		"ACCEPT",
	]);
	await runCommand("iptables", [
		"-I",
		"FORWARD",
		"4",
		"-i",
		tapName,
		"-o",
		hostInterface,
		"-j",
		"DROP",
	]);
	await runCommand("iptables", [
		"-I",
		"FORWARD",
		"5",
		"-i",
		hostInterface,
		"-o",
		tapName,
		"-d",
		guestIp,
		"-j",
		"ACCEPT",
	]);
}

export async function cleanupNetwork(
	tapName: string,
	hostInterface: string,
	hostPublicIp: string,
	subnetCidr: string,
	guestIp: string,
	sshPort: number,
): Promise<void> {
	await runCommand(
		"iptables",
		[
			"-D",
			"INPUT",
			"-i",
			tapName,
			"-m",
			"state",
			"--state",
			"ESTABLISHED,RELATED",
			"-j",
			"ACCEPT",
		],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		[
			"-t",
			"nat",
			"-D",
			"OUTPUT",
			"-d",
			hostPublicIp,
			"-p",
			"tcp",
			"--dport",
			String(sshPort),
			"-j",
			"DNAT",
			"--to-destination",
			`${guestIp}:22`,
		],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		[
			"-t",
			"nat",
			"-D",
			"PREROUTING",
			"-i",
			hostInterface,
			"-p",
			"tcp",
			"--dport",
			String(sshPort),
			"-j",
			"DNAT",
			"--to-destination",
			`${guestIp}:22`,
		],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		[
			"-t",
			"nat",
			"-D",
			"POSTROUTING",
			"-s",
			subnetCidr,
			"-o",
			hostInterface,
			"-j",
			"MASQUERADE",
		],
		{ allowFailure: true },
	);
	await runCommand("iptables", ["-D", "INPUT", "-i", tapName, "-j", "DROP"], {
		allowFailure: true,
	});
	await runCommand(
		"iptables",
		["-D", "FORWARD", "-i", tapName, "!", "-o", hostInterface, "-j", "DROP"],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		["-D", "FORWARD", "-s", subnetCidr, "-d", "169.254.169.254", "-j", "DROP"],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		[
			"-D",
			"FORWARD",
			"-i",
			tapName,
			"-o",
			hostInterface,
			"-m",
			"state",
			"--state",
			"ESTABLISHED,RELATED",
			"-j",
			"ACCEPT",
		],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		["-D", "FORWARD", "-i", tapName, "-o", hostInterface, "-j", "DROP"],
		{ allowFailure: true },
	);
	await runCommand(
		"iptables",
		[
			"-D",
			"FORWARD",
			"-i",
			hostInterface,
			"-o",
			tapName,
			"-d",
			guestIp,
			"-j",
			"ACCEPT",
		],
		{ allowFailure: true },
	);
	await runCommand("ip", ["link", "delete", "dev", tapName], {
		allowFailure: true,
	});
}
