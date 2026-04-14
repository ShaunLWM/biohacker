import { request } from "node:http";

async function firecrackerRequest(
	socketPath: string,
	path: string,
	body: unknown,
) {
	return await new Promise<void>((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = request(
			{
				socketPath,
				path,
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
				},
			},
			(response) => {
				let responseBody = "";
				response.on("data", (chunk) => {
					responseBody += chunk.toString();
				});
				response.on("end", () => {
					const statusCode = response.statusCode ?? 500;

					if (statusCode >= 200 && statusCode < 300) {
						resolve();
						return;
					}

					reject(
						new Error(
							`Firecracker API ${path} failed with ${statusCode}: ${responseBody}`,
						),
					);
				});
			},
		);

		req.on("error", reject);
		req.write(payload);
		req.end();
	});
}

export async function putMachineConfig(
	socketPath: string,
	config: {
		vcpu_count: number;
		mem_size_mib: number;
		ht_enabled?: boolean;
	},
) {
	await firecrackerRequest(socketPath, "/machine-config", config);
}

export async function putBootSource(
	socketPath: string,
	bootSource: {
		kernel_image_path: string;
		boot_args: string;
	},
) {
	await firecrackerRequest(socketPath, "/boot-source", bootSource);
}

export async function putDrive(
	socketPath: string,
	driveId: string,
	drive: {
		path_on_host: string;
		is_root_device: boolean;
		is_read_only: boolean;
	},
) {
	await firecrackerRequest(socketPath, `/drives/${driveId}`, {
		drive_id: driveId,
		...drive,
	});
}

export async function putNetworkInterface(
	socketPath: string,
	ifaceId: string,
	payload: {
		host_dev_name: string;
		guest_mac: string;
	},
) {
	await firecrackerRequest(socketPath, `/network-interfaces/${ifaceId}`, {
		iface_id: ifaceId,
		...payload,
	});
}

export async function startInstance(socketPath: string) {
	await firecrackerRequest(socketPath, "/actions", {
		action_type: "InstanceStart",
	});
}

export async function sendCtrlAltDel(socketPath: string) {
	await firecrackerRequest(socketPath, "/actions", {
		action_type: "SendCtrlAltDel",
	});
}
