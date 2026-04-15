import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { runCommand } from "./command.js";
import { ensureDir, removePath, writeTextFile } from "./fs-utils.js";
import { getDaemonLabTemplate } from "./lab-templates.js";
import type { FirecrackerRuntime } from "./types.js";

const DEFAULT_NAMESERVERS = ["1.1.1.1", "8.8.8.8"];
const REQUIRED_GUEST_SERVICES = [
	"systemd-networkd.service",
	"systemd-resolved.service",
	"ssh.service",
];

export async function cloneBaseImage(
	baseImagePath: string,
	targetPath: string,
): Promise<void> {
	await runCommand("cp", [
		"--reflink=auto",
		"--sparse=always",
		baseImagePath,
		targetPath,
	]);
}

export async function customizeRootfs(
	runtime: Pick<
		FirecrackerRuntime,
		| "instanceDir"
		| "writableRootfsPath"
		| "guestMac"
		| "guestIp"
		| "hostTapIp"
		| "templateId"
		| "username"
	>,
	nameservers?: string[],
): Promise<void> {
	const hostname = `biohacker-${basename(runtime.instanceDir)}`;
	const mountDir = join(runtime.instanceDir, "rootfs-mount");

	await ensureDir(mountDir);

	try {
		await runCommand("mount", [
			"-o",
			"loop,nosuid,nodev",
			runtime.writableRootfsPath,
			mountDir,
		]);
		await writeRootfsConfig(mountDir, runtime, hostname, nameservers);
	} finally {
		await runCommand("umount", [mountDir], { allowFailure: true });
		await removePath(mountDir);
	}
}

async function writeRootfsConfig(
	mountDir: string,
	runtime: Pick<
		FirecrackerRuntime,
		"guestMac" | "guestIp" | "hostTapIp" | "templateId" | "username"
	>,
	hostname: string,
	nameservers = DEFAULT_NAMESERVERS,
) {
	const template = getDaemonLabTemplate(runtime.templateId);
	const guestAccount = await ensureGuestAccount(mountDir, runtime.username);
	const guestHome = join(mountDir, guestAccount.home.replace(/^\/+/, ""));
	const resolvedHome = resolve(guestHome);
	if (!resolvedHome.startsWith(`${resolve(mountDir)}/`)) {
		throw new Error(
			`Guest account home path escapes mount point: ${guestAccount.home}`,
		);
	}
	const sshConfigDir = join(mountDir, "etc", "ssh", "sshd_config.d");

	await ensureDir(guestHome);
	await runCommand("chown", [
		`${guestAccount.uid}:${guestAccount.gid}`,
		guestHome,
	]);

	if (template.weakPassword) {
		await runCommand("chroot", [mountDir, "/usr/sbin/chpasswd"], {
			stdin: `${runtime.username}:${template.weakPassword}\n`,
		});
	}

	await writeTextFile(join(mountDir, "etc", "hostname"), `${hostname}\n`);
	await writeTextFile(
		join(mountDir, "etc", "hosts"),
		[
			"127.0.0.1 localhost",
			`127.0.1.1 ${hostname}`,
			"::1 localhost ip6-localhost ip6-loopback",
			"ff02::1 ip6-allnodes",
			"ff02::2 ip6-allrouters",
			"",
		].join("\n"),
	);
	await ensureDir(join(mountDir, "etc", "systemd", "network"));
	await writeTextFile(
		join(mountDir, "etc", "systemd", "network", "25-biohacker.network"),
		[
			"[Match]",
			`MACAddress=${runtime.guestMac}`,
			"",
			"[Network]",
			`Address=${runtime.guestIp}/30`,
			`Gateway=${runtime.hostTapIp}`,
			...nameservers.map((item) => `DNS=${item}`),
			"LinkLocalAddressing=ipv6",
			"",
		].join("\n"),
	);
	await ensureDir(join(mountDir, "etc", "cloud", "cloud.cfg.d"));
	await writeTextFile(
		join(
			mountDir,
			"etc",
			"cloud",
			"cloud.cfg.d",
			"99-biohacker-disable-network-config.cfg",
		),
		"network: {config: disabled}\n",
	);
	await ensureDir(sshConfigDir);
	await writeTextFile(
		join(sshConfigDir, "25-biohacker-lab.conf"),
		[
			"PasswordAuthentication yes",
			"KbdInteractiveAuthentication no",
			"ChallengeResponseAuthentication no",
			"PubkeyAuthentication no",
			"PermitRootLogin no",
			"UsePAM yes",
			"AuthenticationMethods password",
			"",
		].join("\n"),
	);
	await ensureGuestServicesEnabled(mountDir, REQUIRED_GUEST_SERVICES);
}

async function ensureGuestServicesEnabled(
	mountDir: string,
	services: readonly string[],
) {
	await runCommand("systemctl", [`--root=${mountDir}`, "enable", ...services]);
}

async function ensureGuestAccount(mountDir: string, username: string) {
	const existing = await readGuestAccount(mountDir, username);

	if (existing) {
		return existing;
	}

	const userAddArgs = [
		mountDir,
		"/usr/sbin/useradd",
		"-m",
		"-s",
		"/bin/bash",
		"-U",
	];

	if (username === "ubuntu" && (await groupExists(mountDir, "sudo"))) {
		userAddArgs.push("-G", "sudo");
	}

	userAddArgs.push(username);

	await runCommand("chroot", userAddArgs);

	const created = await readGuestAccount(mountDir, username);

	if (!created) {
		throw new Error(`Failed to create guest user ${username}`);
	}

	return created;
}

async function readGuestAccount(mountDir: string, username: string) {
	const passwdPath = join(mountDir, "etc", "passwd");
	const passwdContents = await readFile(passwdPath, "utf8");
	const accountLine = passwdContents
		.split("\n")
		.find((line) => line.startsWith(`${username}:`));

	if (!accountLine) {
		return null;
	}

	const parts = accountLine.split(":");

	if (parts.length < 7) {
		throw new Error(`Guest passwd entry for ${username} is malformed`);
	}

	const uid = Number(parts[2]);
	const gid = Number(parts[3]);
	const home = parts[5];

	if (!Number.isInteger(uid) || !Number.isInteger(gid) || home.length === 0) {
		throw new Error(`Guest passwd entry for ${username} is incomplete`);
	}

	return { uid, gid, home };
}

async function groupExists(mountDir: string, groupName: string) {
	const groupPath = join(mountDir, "etc", "group");
	const groupContents = await readFile(groupPath, "utf8");
	return groupContents
		.split("\n")
		.some((line) => line.startsWith(`${groupName}:`));
}
