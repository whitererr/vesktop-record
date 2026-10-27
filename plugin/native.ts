import { app, dialog, shell } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RecordingStorage } from "./storage";
import type { CallInfo, NoticeEvent, Preferences, Recording } from "./model";

const configDir = () => join(app.getPath("userData"), "CallRecorder");
let storage: RecordingStorage;
const store = () => storage ??= new RecordingStorage(configDir());
let shutdownTarget: WebContents | undefined;
let quitting = false;
app.on("before-quit", event => {
    if (quitting || !storage?.hasOpenRecording()) return;
    event.preventDefault(); quitting = true;
    void (async () => {
        try {
            if (!shutdownTarget || shutdownTarget.isDestroyed()) throw new Error("Renderer unavailable.");
            await Promise.race([
                shutdownTarget.executeJavaScript("Vencord.Plugins.plugins.CallRecorder.finalizeForShutdown()"),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Shutdown timed out.")), 15000))
            ]);
        } catch { /* Retain partial data if the renderer cannot flush its encoder. */ }
        await storage.interruptAll();
        app.quit();
    })();
});
export async function status(_: unknown) { return store().status(); }
export async function preferences(_: unknown, value: Preferences) { return store().setPreferences(value); }
export async function chooseFolder(_: unknown) {
    const result = await dialog.showOpenDialog({ title: "Save call recordings in…", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return store().selectFolder(result.filePaths[0]);
}
export async function revealFolder(_: unknown) { shell.showItemInFolder(await store().selectedPath()); }
export async function preflight(_: unknown) { return store().preflight(); }
export async function begin(event: IpcMainInvokeEvent, call: CallInfo, notice: Recording["notice"]) { shutdownTarget = event.sender; return store().begin(call, notice); }
export async function append(_: unknown, id: string, sequence: number, bytes: Uint8Array) { return store().append(id, sequence, bytes); }
export async function checkpoint(_: unknown, id: string, durationMs: number, events: Recording["events"], deliveries: Recording["deliveries"]) { return store().checkpoint(id, durationMs, events, deliveries); }
export async function finish(_: unknown, id: string, interrupted: boolean) { return store().finish(id, interrupted); }
export async function recordings(_: unknown) { return store().list(); }
export async function renameTitle(_: unknown, id: string, title: string) { return store().renameTitle(id, title); }
export async function locateRecording(_: unknown, id: string) {
    const result = await dialog.showOpenDialog({ title: "Locate moved recording", properties: ["openFile"], filters: [{ name: "WebM audio", extensions: ["webm"] }] });
    if (!result.canceled && result.filePaths[0]) await store().locate(id, result.filePaths[0]);
}
export async function readRecording(_: unknown, id: string) { return store().read(id); }
export async function reveal(_: unknown, id: string) { shell.showItemInFolder(await store().path(id)); }
export async function openExternally(_: unknown, id: string) {
    const error = await shell.openPath(await store().path(id));
    if (error) throw new Error(error);
}
export async function exportRecording(_: unknown, id: string) {
    const records = await store().list(); const record = records.find(r => r.id === id);
    if (!record) throw new Error("Recording not found.");
    const result = await dialog.showSaveDialog({ title: "Export recording", defaultPath: record.filename, filters: [{ name: "WebM audio", extensions: ["webm"] }] });
    if (result.canceled || !result.filePath) return;
    return store().exportTo(id, result.filePath);
}
export async function removeRecording(_: unknown, id: string, files: boolean) {
    if (files) {
        const result = await dialog.showMessageBox({ type: "warning", title: "Delete recording permanently?", message: "The recording and sidecar will be permanently deleted.", buttons: ["Cancel", "Delete"], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return;
    }
    await store().remove(id, files);
}
export async function pairCompanion(_: unknown) {
    const result = await dialog.showOpenDialog({ title: "Select the companion pairing file", properties: ["openFile"], filters: [{ name: "Pairing JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const raw = await readFile(result.filePaths[0], "utf8");
    if (raw.length > 4096) throw new Error("Invalid pairing file.");
    const value = validatePairing(JSON.parse(raw));
    await mkdir(configDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(configDir(), "pairing.json"), JSON.stringify(value), { mode: 0o600 });
    return { botId: value.botId };
}
function validatePairing(value: any): { version: 1; port: number; secret: string; botId: string } {
    if (value?.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.secret) || !/^\d{5,22}$/.test(value.botId)) throw new Error("Invalid companion pairing file.");
    return { version: 1, port: value.port, secret: value.secret, botId: value.botId };
}
export async function sendNotice(_: unknown, event: NoticeEvent, text: string, session: { id: string; call: CallInfo }) {
    if (session.call.kind !== "server") throw new Error("Bot notices support server calls only. Select manual notices for private calls.");
    const pairing = validatePairing(JSON.parse(await readFile(join(configDir(), "pairing.json"), "utf8").catch(() => { throw new Error("Pair the notice companion first."); })));
    const key = randomUUID();
    const body = JSON.stringify({ sessionId: session.id, channelId: session.call.id, recorderId: session.call.recorderId, event, text, key });
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`http://127.0.0.1:${pairing.port}/event`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.secret}` }, body, signal: AbortSignal.timeout(10000), redirect: "error" });
        if (response.ok) return (await response.json()).outcome as string;
        if (response.status !== 503 || attempt === 2) throw new Error("Companion notice failed. Check pairing, bot permissions and call membership.");
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
    throw new Error("Notice delivery failed.");
}
export async function heartbeat(_: unknown, session: { id: string; call: CallInfo }) {
    const pairing = validatePairing(JSON.parse(await readFile(join(configDir(), "pairing.json"), "utf8")));
    const response = await fetch(`http://127.0.0.1:${pairing.port}/heartbeat`, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.secret}` },
        body: JSON.stringify({ sessionId: session.id, channelId: session.call.id, recorderId: session.call.recorderId }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Companion heartbeat failed.");
}
export async function exportDiagnostics(_: unknown, summary: { phase: string; hookUpdates: number; sourceCount: number; encoderSupported: boolean }) {
    const status = await store().status();
    const records = await store().list();
    const report = { version: 1, generatedAt: new Date().toISOString(), vesktopVersion: app.getVersion(),
        vencordRevision: "443688b5366a4d43e9868519f48a4544cd7520d4", realCallValidated: false,
        phase: String(summary.phase).slice(0, 30), hookUpdates: Number(summary.hookUpdates) || 0, sourceCount: Number(summary.sourceCount) || 0,
        encoderSupported: Boolean(summary.encoderSupported), folderSelected: Boolean(status.folder),
        recordings: { total: records.length, interrupted: records.filter(r => r.status !== "complete").length, bytes: status.usageBytes } };
    const result = await dialog.showSaveDialog({ title: "Export recording diagnostics", defaultPath: "call-recorder-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return;
    await writeFile(result.filePath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
}
