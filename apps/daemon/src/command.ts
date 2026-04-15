import { spawn } from "node:child_process";

interface RunCommandOptions {
	allowFailure?: boolean;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function runCommand(
	command: string,
	args: string[],
	options: RunCommandOptions = {},
) {
	return await new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();

		child.on("error", reject);
		child.on("close", (code) => {
			const exitCode = code ?? -1;

			if (exitCode !== 0 && !options.allowFailure) {
				reject(
					new Error(
						[
							`Command failed: ${command} ${args.join(" ")}`,
							stdout.trim(),
							stderr.trim(),
						]
							.filter(Boolean)
							.join("\n"),
					),
				);
				return;
			}

			resolve({
				code: exitCode,
				stdout,
				stderr,
			});
		});
	});
}
