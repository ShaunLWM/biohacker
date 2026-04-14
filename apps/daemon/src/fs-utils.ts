import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

export async function ensureDir(path: string) {
	await mkdir(path, { recursive: true });
}

export async function writeTextFile(path: string, contents: string) {
	await writeFile(path, contents, "utf8");
}

export async function readJsonFile<T>(path: string) {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function removePath(path: string) {
	await rm(path, { recursive: true, force: true });
}
