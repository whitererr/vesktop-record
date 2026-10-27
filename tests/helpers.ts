import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStorage } from "../plugin/storage";
import type { CallInfo } from "../plugin/model";

export const call: CallInfo = { id: "12345678901234567", kind: "server", name: "General", guildId: "23456789012345678", guildName: "Friends", recorderId: "34567890123456789", recorderName: "Sam", participants: ["34567890123456789", "45678901234567890"] };
export async function fixture() {
    const base = await mkdtemp(join(tmpdir(), "call-recorder-test-"));
    const folder = join(base, "audio"); await mkdir(folder);
    const config = join(base, "config");
    const store = new RecordingStorage(config); await store.selectFolder(folder);
    return { base, folder, config, store };
}
