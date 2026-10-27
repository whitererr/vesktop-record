import { constants } from "node:fs";
import { access, copyFile, link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaults, filename, validateCall } from "./model";
import type { CallInfo, Preferences, Recording } from "./model";

interface Root { id: string; path: string; dev: number; ino: number }
interface Config { version: 1; selected?: string; roots: Root[]; recordings: Recording[]; preferences: Preferences; located?: Record<string, { path: string; dev: number; ino: number }> }
interface Writer { file: FileHandle; record: Recording; tail: Promise<void>; queued: number; sequence: number; closing: boolean; failure?: Error }
export const MAX_CHUNK = 2 * 1024 * 1024;
const MAX_QUEUED = 16 * 1024 * 1024;

/** Native-only filesystem boundary. Renderers supply session IDs, never write paths. */
export class RecordingStorage {
    private config!: Config;
    private initialized?: Promise<void>;
    private saveTail: Promise<void> = Promise.resolve();
    private writers = new Map<string, Writer>();
    private allocating = false;
    constructor(private readonly configDir: string) { }

    private init(): Promise<void> {
        return this.initialized ??= (async () => {
            await mkdir(this.configDir, { recursive: true, mode: 0o700 });
            try {
                this.config = JSON.parse(await readFile(join(this.configDir, "library.json"), "utf8"));
                if (this.config.version !== 1 || !Array.isArray(this.config.roots) || !Array.isArray(this.config.recordings)) throw new Error("Unsupported recording library. Back it up before repairing it.");
                this.config.preferences = { ...structuredClone(defaults), ...this.config.preferences,
                    templates: { ...defaults.templates, ...this.config.preferences?.templates },
                    noticeEvents: { ...defaults.noticeEvents, ...this.config.preferences?.noticeEvents } };
                for (const record of this.config.recordings) {
                    if (record.status === "partial") {
                        record.status = "interrupted";
                        record.events.push({ type: "restart", at: new Date().toISOString(), detail: "Previous session did not finalize. Recovery is not guaranteed." });
                    }
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                this.config = { version: 1, roots: [], recordings: [], preferences: structuredClone(defaults) };
            }
        })();
    }
    private async atomic(path: string, value: unknown): Promise<void> {
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
        finally { await file.close(); }
        try { await rename(temporary, path); }
        catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    }
    private save(): Promise<void> {
        // Serialize snapshots too, so an older write cannot replace a newer library.
        const value = structuredClone(this.config);
        const task = this.saveTail.then(() => this.atomic(join(this.configDir, "library.json"), value));
        this.saveTail = task.catch(() => {});
        return task;
    }
    private async root(id?: string): Promise<Root> {
        await this.init();
        const root = this.config.roots.find(r => r.id === id);
        if (!root) throw new Error("Choose a recording folder in Storage first.");
        const canonical = await realpath(root.path);
        const info = await stat(root.path);
        if (canonical !== root.path || info.dev !== root.dev || info.ino !== root.ino || !info.isDirectory()) throw new Error("Recording folder changed. Choose it again in Storage.");
        return root;
    }
    private async record(id: string): Promise<Recording> {
        await this.init();
        if (typeof id !== "string") throw new Error("Invalid session ID.");
        const result = this.config.recordings.find(r => r.id === id);
        if (!result) throw new Error("Recording not found.");
        return result;
    }
    async selectFolder(chosenByNativeDialog: string): Promise<string> {
        await this.init();
        const path = await realpath(resolve(chosenByNativeDialog));
        const info = await stat(path);
        if (!info.isDirectory()) throw new Error("Select a directory.");
        // A real exclusive file probe detects read-only mounts and most permission failures.
        const probe = join(path, `.call-recorder-${randomUUID()}.tmp`);
        const file = await open(probe, "wx", 0o600);
        await file.close(); await unlink(probe);
        let root = this.config.roots.find(r => r.path === path && r.dev === info.dev && r.ino === info.ino);
        if (!root) { root = { id: randomUUID(), path, dev: info.dev, ino: info.ino }; this.config.roots.push(root); }
        this.config.selected = root.id;
        await this.save();
        return path;
    }
    async status() {
        await this.init();
        const selected = this.config.roots.find(r => r.id === this.config.selected);
        return { folder: selected?.path ?? null, preferences: structuredClone(this.config.preferences),
            usageBytes: this.config.recordings.reduce((n, r) => n + r.bytes, 0) };
    }
    async setPreferences(input: Preferences): Promise<void> {
        await this.init();
        if (JSON.stringify(input).length > 20000 || !["manual", "bot", "off"].includes(input.noticeMode)
            || typeof input.remoteOnly !== "boolean" || typeof input.requireNotice !== "boolean"
            || typeof input.receivePopups !== "boolean" || !Number.isFinite(input.sizeLimitMb) || input.sizeLimitMb < 0
            || !Array.isArray(input.autoChannels) || input.autoChannels.length > 500 || input.autoChannels.some(id => !/^\d{5,22}$/.test(id))
            || (input.trustedBotId !== "" && !/^\d{5,22}$/.test(input.trustedBotId))) throw new Error("Invalid recording preferences.");
        for (const event of Object.keys(defaults.templates) as (keyof typeof defaults.templates)[]) {
            if (typeof input.templates?.[event] !== "string" || input.templates[event].length > 1500 || !input.templates[event].trim()
                || typeof input.noticeEvents?.[event] !== "boolean") throw new Error("Every notice template needs 1 to 1500 characters and an event switch.");
        }
        this.config.preferences = structuredClone(input); await this.save();
    }
    async preflight(): Promise<void> {
        await this.init();
        const root = await this.root(this.config.selected);
        await access(root.path, constants.W_OK);
        const limit = this.config.preferences.sizeLimitMb * 1024 * 1024;
        if (limit && this.config.recordings.reduce((n, r) => n + r.bytes, 0) >= limit) throw new Error("Recording storage limit reached. Delete or export recordings, or raise the limit.");
    }
    async begin(call: CallInfo, notice: Recording["notice"]): Promise<Recording> {
        if (this.allocating || this.writers.size) throw new Error("Another recording is already open.");
        this.allocating = true;
        try { return await this.allocate(call, notice); }
        finally { this.allocating = false; }
    }
    private async allocate(call: CallInfo, notice: Recording["notice"]): Promise<Recording> {
        validateCall(call);
        if (!notice || !["manual", "bot", "off"].includes(notice.mode) || typeof notice.required !== "boolean") throw new Error("Invalid notice configuration.");
        if (this.writers.size) throw new Error("Another recording is already open.");
        await this.preflight();
        const root = await this.root(this.config.selected);
        const started = new Date();
        for (let tries = 0; tries < 5; tries++) {
            const id = randomUUID();
            const name = filename(call, started, id);
            const output = join(root.path, name);
            try { await lstat(output); continue; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            let file: FileHandle;
            try { file = await open(output + ".partial", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
            const record: Recording = {
                version: 1, id, rootId: root.id, filename: name, title: name.slice(0, -5),
                call: structuredClone(call), startedAt: started.toISOString(), utcOffsetMinutes: -started.getTimezoneOffset(),
                durationMs: 0, bytes: 0, mime: "audio/webm;codecs=opus", status: "partial", sources: "remote-only",
                events: [], notice: structuredClone(notice), deliveries: []
            };
            this.writers.set(id, { file, record, tail: Promise.resolve(), queued: 0, sequence: 0, closing: false });
            this.config.recordings.unshift(record);
            try {
                const sidecar = await open(output.replace(/\.webm$/, ".json"), "wx", 0o600);
                try { await sidecar.writeFile(JSON.stringify(record, null, 2)); } finally { await sidecar.close(); }
                await this.save();
                return structuredClone(record);
            } catch (error) {
                this.writers.delete(id);
                this.config.recordings = this.config.recordings.filter(r => r.id !== id);
                await file.close();
                // Keep any orphaned partial file for recovery rather than deleting uncertain data.
                throw error;
            }
        }
        throw new Error("Could not allocate a unique recording file.");
    }
    async append(id: string, sequence: number, bytes: Uint8Array): Promise<void> {
        const writer = this.writers.get(id);
        if (!writer || writer.closing) throw new Error("Recording is not open.");
        if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_CHUNK) throw new Error("Invalid audio chunk size.");
        if (!Number.isInteger(sequence) || sequence !== writer.sequence) throw new Error("Out-of-order audio chunk.");
        if (writer.queued + bytes.byteLength > MAX_QUEUED) throw new Error("Recording disk queue is full.");
        writer.sequence++; writer.queued += bytes.byteLength;
        const task = writer.tail.then(async () => {
            if (writer.failure) throw writer.failure;
            await this.root(writer.record.rootId);
            await writer.file.writeFile(bytes);
            writer.record.bytes += bytes.byteLength;
        });
        writer.tail = task.catch(error => { writer.failure = error; }).finally(() => { writer.queued -= bytes.byteLength; });
        return task;
    }
    async checkpoint(id: string, durationMs: number, events: Recording["events"], deliveries: Recording["deliveries"]): Promise<void> {
        const record = await this.record(id);
        if (!Number.isFinite(durationMs) || durationMs < 0 || JSON.stringify([events, deliveries]).length > 200000) throw new Error("Invalid recording metadata.");
        record.durationMs = durationMs; record.events = structuredClone(events); record.deliveries = structuredClone(deliveries);
        const root = await this.root(record.rootId);
        await this.atomic(join(root.path, record.filename.replace(/\.webm$/, ".json")), record);
        await this.save();
    }
    async finish(id: string, interrupted = false): Promise<Recording> {
        const writer = this.writers.get(id);
        if (!writer || writer.closing) throw new Error("Recording is not open.");
        writer.closing = true;
        await writer.tail;
        const record = writer.record;
        let failure = writer.failure;
        try { await writer.file.sync(); } catch (error) { failure ??= error as Error; }
        try { await writer.file.close(); } catch (error) { failure ??= error as Error; }
        this.writers.delete(id);
        record.endedAt = new Date().toISOString(); record.status = "interrupted";
        try {
            const root = await this.root(record.rootId);
            if (!interrupted && !failure && record.bytes) {
                const partial = join(root.path, record.filename + ".partial");
                const info = await lstat(partial);
                if (!info.isFile() || info.isSymbolicLink()) throw new Error("Recording file was replaced. Finalization refused.");
                // Hard-link + unlink gives an atomic no-overwrite finalize on this filesystem.
                await link(partial, join(root.path, record.filename));
                await unlink(partial);
                record.status = "complete";
            }
            await this.atomic(join(root.path, record.filename.replace(/\.webm$/, ".json")), record);
        } catch (error) { failure ??= error as Error; }
        await this.save();
        if (failure) throw failure;
        return structuredClone(record);
    }
    async list(): Promise<(Recording & { missing: boolean })[]> {
        await this.init();
        return Promise.all(this.config.recordings.map(async record => {
            let missing = false;
            try { await this.path(record.id); } catch { missing = true; }
            return { ...structuredClone(record), missing };
        }));
    }
    async path(id: string): Promise<string> {
        const record = await this.record(id);
        const located = this.config.located?.[id];
        if (located) {
            const info = await lstat(located.path);
            if (!info.isFile() || info.isSymbolicLink() || info.dev !== located.dev || info.ino !== located.ino || await realpath(located.path) !== located.path) throw new Error("Located recording changed. Locate it again.");
            return located.path;
        }
        const root = await this.root(record.rootId);
        if (record.filename !== record.filename.split(/[\\/]/).pop() || !record.filename.endsWith(".webm")) throw new Error("Invalid recording filename.");
        const path = join(root.path, record.filename + (record.status === "complete" ? "" : ".partial"));
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("Recording is not a regular file.");
        return path;
    }
    async read(id: string): Promise<Uint8Array> {
        const path = await this.path(id);
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            if ((await file.stat()).size > 128 * 1024 * 1024) throw new Error("Use Open externally for recordings larger than 128 MiB.");
            return new Uint8Array(await file.readFile());
        } finally { await file.close(); }
    }
    async renameTitle(id: string, title: string): Promise<void> {
        const record = await this.record(id);
        if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("Title must contain 1 to 200 characters.");
        record.title = title.trim(); await this.save();
    }
    async locate(id: string, chosenByNativeDialog: string): Promise<void> {
        const record = await this.record(id);
        if (this.writers.has(id) || record.status !== "complete") throw new Error("Only completed recordings can be located.");
        const path = await realpath(chosenByNativeDialog);
        const info = await stat(path);
        if (!info.isFile() || !path.toLowerCase().endsWith(".webm")) throw new Error("Select the moved WebM recording.");
        this.config.located ??= {};
        this.config.located[id] = { path, dev: info.dev, ino: info.ino };
        await this.save();
    }
    async exportTo(id: string, destinationFromNativeDialog: string): Promise<void> {
        // Export never overwrites a file, including a symlink selected as the destination.
        await copyFile(await this.path(id), destinationFromNativeDialog, constants.COPYFILE_EXCL);
    }
    async remove(id: string, files: boolean): Promise<void> {
        if (this.writers.has(id)) throw new Error("Stop recording before deleting it.");
        const record = await this.record(id);
        if (files && this.config.located?.[id]) {
            // Only the specific file granted by the picker is deletable. No adjacent files are touched.
            await unlink(await this.path(id));
        } else if (files) {
            const root = await this.root(record.rootId);
            const path = join(root.path, record.filename + (record.status === "complete" ? "" : ".partial"));
            // Unlinking removes the entry itself; it never follows a substituted symlink.
            await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
            await unlink(join(root.path, record.filename.replace(/\.webm$/, ".json"))).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
        this.config.recordings = this.config.recordings.filter(r => r.id !== id);
        if (this.config.located) delete this.config.located[id];
        await this.save();
    }
    async selectedPath(): Promise<string> { await this.init(); return (await this.root(this.config.selected)).path; }
    hasOpenRecording(): boolean { return this.writers.size > 0; }
    async interruptAll(): Promise<void> { for (const id of [...this.writers.keys()]) await this.finish(id, true).catch(() => {}); }
}
