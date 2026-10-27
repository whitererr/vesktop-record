import type { NoticeEvent } from "./model";

export interface NoticePayload {
    v: 1;
    sessionId: string;
    recorderId: string;
    channelId: string;
    event: NoticeEvent;
    sequence: number;
    issuedAt: number;
    expiresAt: number;
}
const events = new Set(["starting", "started", "paused", "resumed", "stopped", "arrival"]);
export const NOTICE_PREFIX = "call-recorder:v1:";
export function validPayload(value: unknown, now = Date.now()): value is NoticePayload {
    const p = value as NoticePayload;
    return Boolean(p && p.v === 1 && typeof p.sessionId === "string" && /^[a-f0-9-]{36}$/i.test(p.sessionId)
        && /^\d{5,22}$/.test(p.recorderId) && /^\d{5,22}$/.test(p.channelId)
        && events.has(p.event) && Number.isSafeInteger(p.sequence) && p.sequence > 0
        && Number.isFinite(p.issuedAt) && Number.isFinite(p.expiresAt)
        && p.issuedAt <= now + 5000 && p.expiresAt > now && p.expiresAt > p.issuedAt
        && p.expiresAt - p.issuedAt <= 120000);
}
/** Trust author identity and call membership before interpreting event state. */
export class NoticeReceiver {
    private sessions = new Map<string, { payload: NoticePayload; text: string }>();
    accept(authorId: string, trustedBotId: string, currentChannelId: string | undefined,
        participants: string[], payload: unknown, text: string, now = Date.now()): NoticePayload | null {
        if (!trustedBotId || authorId !== trustedBotId || !validPayload(payload, now)
            || payload.channelId !== currentChannelId || !participants.includes(payload.recorderId)) return null;
        const previous = this.sessions.get(payload.sessionId)?.payload;
        if (previous && (payload.sequence <= previous.sequence || previous.recorderId !== payload.recorderId || previous.channelId !== payload.channelId)) return null;
        if (this.sessions.size > 500) {
            for (const [id, item] of this.sessions) if (item.payload.expiresAt < now - 600000) this.sessions.delete(id);
            if (this.sessions.size > 500) return null;
        }
        this.sessions.set(payload.sessionId, { payload: structuredClone(payload), text: text.slice(0, 2000) });
        return payload;
    }
    statuses(channelId: string | undefined, now = Date.now()) {
        return Array.from(this.sessions.values()).filter(item => item.payload.channelId === channelId).map(item => ({
            ...item, state: item.payload.expiresAt <= now ? "unknown" : item.payload.event === "stopped" ? "stopped"
                : item.payload.event === "paused" ? "paused" : item.payload.event === "starting" ? "starting" : "recording"
        }));
    }
    clear() { this.sessions.clear(); }
}
