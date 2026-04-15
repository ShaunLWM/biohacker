import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";

export async function ensureDir(path: string) {
	await mkdir(path, { recursive: true });
}

export async function writeTextFile(path: string, contents: string) {
	await writeFile(path, contents, "utf8");
}

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T>;
export async function readJsonFile<T>(path: string): Promise<T>;
export async function readJsonFile<T>(path: string, schema?: z.ZodType<T>): Promise<T> {
	const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (schema !== undefined) {
		return schema.parse(raw);
	}
	return raw as T;
}

export async function removePath(path: string) {
	await rm(path, { recursive: true, force: true });
}

export async function exists(path: string) {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
