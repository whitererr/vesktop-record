import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { NoticeEvent } from "../plugin/model";
import type { NoticePayload } from "../plugin/notices";

export interface BotConfig { recorderId: string; channelIds: string[] }
export interface BotTransport {
    verify(channelId: string, recorderId: string): Promise<void>;
    post(channelId: string, content: string, payload: NoticePayload, existingMessageId?: string): Promise<string>;
}
interface EventInput { sessionId: string; channelId: string; recorderId: string; event: NoticeEvent; text: string; key: string }
export function createCompanion(config: BotConfig, secret: string, transport: BotTransport): { server: Server; close(): Promise<void> } {
    const sessions = new Map<string, { channelId: string; recorderId: string; sequence: number; messageId: string; text: string; event: NoticeEvent; updated: number }>();
    const results = new Map<string, { at: number; signature: string; result: unknown }>();
    let tail = Promise.resolve();
    let lastPost = 0;
    const allowedEvents = ["starting", "started", "paused", "resumed", "stopped", "arrival"];
    const server = createServer(async (req, res) => {
        const respond = (status: number, value: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
        };
        const auth = req.headers.authorization ?? "";
        const expected = `Bearer ${secret}`;
        if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { respond(401, { error: "Pairing required." }); return; }
        // Native requests have no Origin. Never expose a renderer-facing web API or CORS route.
        if (req.headers.origin || req.method !== "POST" || !["/event", "/heartbeat"].includes(req.url ?? "")) { respond(404, { error: "Unknown action." }); return; }
        try {
            let body = "";
            for await (const chunk of req) {
                body += chunk.toString();
                if (Buffer.byteLength(body) > 8192) { respond(413, { error: "Request too large." }); return; }
            }
            const input: EventInput = JSON.parse(body);
            if (req.url === "/heartbeat") {
                const item = sessions.get(input.sessionId);
                if (!item || item.channelId !== input.channelId || input.recorderId !== config.recorderId || item.recorderId !== input.recorderId || !config.channelIds.includes(input.channelId)) { respond(400, { error: "Unknown session." }); return; }
                await transport.verify(input.channelId, input.recorderId);
                item.updated = Date.now(); respond(200, { ok: true }); return;
            }
            if (!input || !/^[a-f0-9-]{36}$/i.test(input.sessionId) || !/^[a-f0-9-]{36}$/i.test(input.key)
                || input.recorderId !== config.recorderId || !config.channelIds.includes(input.channelId)
                || !allowedEvents.includes(input.event) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 1900) {
                respond(400, { error: "Event is outside the configured recorder or channels." }); return;
            }
            const task = tail.then(async () => {
                const previous = results.get(input.key);
                const signature = JSON.stringify(input);
                if (previous) {
                    if (previous.signature !== signature) throw new Error("Idempotency key reused for a different event.");
                    return previous.result;
                }
                if (Date.now() - lastPost < 700) throw new Error("Notice rate limit. Retry shortly.");
                await transport.verify(input.channelId, input.recorderId);
                const existing = sessions.get(input.sessionId);
                if (existing && (existing.channelId !== input.channelId || existing.recorderId !== input.recorderId)) throw new Error("Session identity cannot change.");
                const sequence = (existing?.sequence ?? 0) + 1;
                const payload: NoticePayload = { v: 1, sessionId: input.sessionId, recorderId: input.recorderId, channelId: input.channelId,
                    event: input.event, sequence, issuedAt: Date.now(), expiresAt: Date.now() + 90000 };
                const messageId = await transport.post(input.channelId, input.text, payload, existing?.messageId);
                lastPost = Date.now();
                // Late arrivals get a separate readable notice; the status message is kept current too.
                if (input.event === "arrival" && existing) await transport.post(input.channelId, input.text, payload);
                sessions.set(input.sessionId, { channelId: input.channelId, recorderId: input.recorderId, sequence, messageId, text: input.text, event: input.event, updated: Date.now() });
                const result = { outcome: "Chat notice posted; plugin notice event posted", sequence };
                results.set(input.key, { at: Date.now(), signature, result });
                return result;
            });
            tail = task.then(() => {}, () => {});
            respond(200, await task);
        } catch (error) {
            // Do not relay upstream HTTP details, tokens or posted message content.
            respond(503, { error: error instanceof Error && error.message.startsWith("Notice rate limit") ? error.message : "Notice delivery failed. Check bot connectivity, channel permissions and recorder membership." });
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    const refresh = setInterval(() => {
        const work = tail.then(async () => {
            for (const [id, item] of sessions) {
                if (Date.now() - item.updated > 45000 || item.event === "stopped" || item.event === "starting") { if (Date.now() - item.updated > 600000) sessions.delete(id); continue; }
                try {
                    await transport.verify(item.channelId, item.recorderId);
                    const payload: NoticePayload = { v: 1, sessionId: id, channelId: item.channelId, recorderId: item.recorderId,
                        event: item.event, sequence: item.sequence + 1, issuedAt: Date.now(), expiresAt: Date.now() + 90000 };
                    await transport.post(item.channelId, item.text, payload, item.messageId);
                    item.sequence++; // No fabricated stop if refresh or voice membership fails.
                } catch { /* The lease expires and receivers show unknown. */ }
            }
            for (const [key, value] of results) if (Date.now() - value.at > 600000) results.delete(key);
        });
        tail = work.catch(() => {});
    }, 30000);
    refresh.unref();
    return { server, async close() { clearInterval(refresh); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
