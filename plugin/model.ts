export type Phase = "idle" | "preparing" | "countdown" | "recording" | "paused" | "stopping" | "saved" | "interrupted" | "error";
export type NoticeMode = "manual" | "bot" | "off";
export type NoticeEvent = "starting" | "started" | "paused" | "resumed" | "stopped" | "arrival";
export interface CallInfo {
    id: string;
    kind: "server" | "dm" | "group";
    name: string;
    guildId?: string;
    guildName?: string;
    recorderId: string;
    recorderName: string;
    participants: string[];
}
export interface Preferences {
    remoteOnly: boolean;
    noticeMode: NoticeMode;
    requireNotice: boolean;
    autoChannels: string[];
    trustedBotId: string;
    receivePopups: boolean;
    sizeLimitMb: number;
    templates: Record<NoticeEvent, string>;
    noticeEvents: Record<NoticeEvent, boolean>;
}
export const defaults: Preferences = {
    remoteOnly: false, noticeMode: "manual", requireNotice: true,
    autoChannels: [], trustedBotId: "", receivePopups: true, sizeLimitMb: 0,
    templates: {
        starting: "{recorder} will start recording audio in {call} in 3 seconds.",
        started: "{recorder} is recording audio in {call}.",
        paused: "{recorder} paused audio recording.",
        resumed: "{recorder} resumed audio recording in {call}.",
        stopped: "{recorder} stopped audio recording.",
        arrival: "Audio recording by {recorder} is active in {call}."
    },
    noticeEvents: { starting: true, started: true, paused: true, resumed: true, stopped: true, arrival: true }
};
export interface Recording {
    version: 1;
    id: string;
    rootId: string;
    filename: string;
    title: string;
    call: CallInfo;
    startedAt: string;
    endedAt?: string;
    utcOffsetMinutes: number;
    durationMs: number;
    bytes: number;
    mime: string;
    status: "partial" | "complete" | "interrupted";
    sources: "remote-only";
    events: { type: string; at: string; detail?: string }[];
    notice: { mode: NoticeMode; required: boolean };
    deliveries: { event: NoticeEvent; at: string; outcome: string }[];
}
export function safeName(value: string, fallback = "Call"): string {
    const result = value.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-")
        .replace(/\s+/g, "-").replace(/^[. ]+|[. ]+$/g, "");
    const truncated = Array.from(result).slice(0, 42).join("");
    // Byte limits matter on Linux too. Leave room for timestamps, suffix and sidecar.
    const bounded = new TextEncoder().encode(truncated).length > 70 ? Array.from(truncated).slice(0, 17).join("") : truncated;
    return !bounded || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(bounded) ? fallback : bounded;
}
export function callLabel(call: CallInfo): string {
    return call.kind === "server"
        ? `${safeName(call.guildName || call.guildId || "Server")}__${safeName(call.name || call.id)}`
        : `${call.kind === "dm" ? "DM" : "Group-DM"}__${safeName(call.name || call.id)}`;
}
export function filename(call: CallInfo, date: Date, id: string): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
    return `${stamp}__${callLabel(call)}__${id.slice(0, 8)}.webm`;
}
export function noticeText(template: string, call: CallInfo, durationMs = 0): string {
    if (!template.trim() || template.length > 1500) throw new Error("Notice must contain 1 to 1500 characters.");
    const values: Record<string, string> = {
        recorder: call.recorderName, call: call.kind === "server" ? `${call.guildName || call.guildId} / ${call.name || call.id}` : call.name || call.id,
        time: new Date().toLocaleString(), duration: `${Math.floor(durationMs / 1000)}s`
    };
    return template.replace(/\{(recorder|call|time|duration)\}/g, (_, key) => values[key]).replace(/@/g, "@\u200b").slice(0, 1900);
}
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
export function recordingStartLabel(record: Pick<Recording, "startedAt" | "utcOffsetMinutes">): string {
    const offset = record.utcOffsetMinutes;
    const local = new Date(Date.parse(record.startedAt) + offset * 60000).toISOString().slice(0, 19).replace("T", " ");
    return `${local} UTC${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
}
export function validateCall(call: CallInfo): void {
    if (!call || !/^\d{5,22}$/.test(call.id) || !/^\d{5,22}$/.test(call.recorderId) || !["server", "dm", "group"].includes(call.kind)) throw new Error("Invalid call identity.");
    if (call.kind === "server" && !/^\d{5,22}$/.test(call.guildId || "")) throw new Error("Invalid server identity.");
    if ([call.name, call.guildName ?? "", call.recorderName].some(s => typeof s !== "string" || s.length > 300)) throw new Error("Invalid call label.");
    if (!Array.isArray(call.participants) || call.participants.length > 1000 || call.participants.some(id => !/^\d{5,22}$/.test(id))) throw new Error("Invalid participant list.");
}
