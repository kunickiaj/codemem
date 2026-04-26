import { homedir } from "node:os";

export function codememHomeDir(): string {
	return process.env.HOME?.trim() || homedir();
}
