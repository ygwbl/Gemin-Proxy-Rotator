import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "./paths.js";

const pendingAtomicWrites = new Map<string, Promise<void>>();

async function ensureParentDir(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

export async function readTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch (err) {
		if (isNotFoundError(err)) return null;
		throw err;
	}
}

export async function writeTextFileAtomic(
	path: string,
	contents: string,
): Promise<void> {
	const previous = pendingAtomicWrites.get(path) ?? Promise.resolve();
	const write = previous.catch(() => undefined).then(async () => {
		await ensureParentDir(path);
		const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(tempPath, contents, "utf-8");
			await rename(tempPath, path);
		} catch (err) {
			await rm(tempPath, { force: true }).catch(() => undefined);
			throw err;
		}
	});

	pendingAtomicWrites.set(path, write);
	const clear = (): void => {
		if (pendingAtomicWrites.get(path) === write) {
			pendingAtomicWrites.delete(path);
		}
	};
	void write.then(clear, clear);
	await write;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
	const raw = await readTextFile(path);
	if (!raw) return null;
	return JSON.parse(raw) as T;
}

export async function writeJsonFileAtomic(
	path: string,
	value: unknown,
): Promise<void> {
	await writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function getBackupDir(): Promise<string> {
	const dir = join(getConfigDir(), "backups");
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function backupFile(
	path: string,
	label: string,
): Promise<string | null> {
	const contents = await readTextFile(path);
	if (contents === null) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = join(await getBackupDir(), `${label}-${stamp}.bak`);
	await writeTextFileAtomic(backupPath, contents);
	return backupPath;
}

export async function listBackups(): Promise<string[]> {
	const dir = await getBackupDir();
	return (await readdir(dir))
		.filter((name) => name.endsWith(".bak"))
		.sort()
		.reverse()
		.map((name) => join(dir, name));
}

export async function removeFileIfExists(path: string): Promise<void> {
	await rm(path, { force: true });
}

function isNotFoundError(err: unknown): boolean {
	return (
		err instanceof Error &&
		"code" in err &&
		(err as NodeJS.ErrnoException).code === "ENOENT"
	);
}
