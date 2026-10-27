/*
 * CallRecorder, a Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import "./style.css";
import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { createRoot, MessageStore, React } from "@webpack/common";
import type { OutputData } from "./audio";
import { NOTICE_PREFIX } from "./notices";
import { Native, changed, controller, currentCall, preferences, receiver, refresh, registry, setRuntimeError } from "./runtime";
import { Controls, Dock, RecorderPanel } from "./ui";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let checkpoints: ReturnType<typeof setInterval> | undefined;
let heartbeats: ReturnType<typeof setInterval> | undefined;
const shutdown = () => { void controller.stop(false); };
function receive(message: any) {
    if (message?.channel_id && message?.id) message = { ...MessageStore.getMessage(message.channel_id, message.id), ...message };
    if (!preferences.receivePopups || !message?.author?.bot) return;
    const call = currentCall(); if (!call || call.kind !== "server") return;
    for (const embed of message.embeds ?? []) {
        const text = embed.footer?.text;
        if (typeof text !== "string" || !text.startsWith(NOTICE_PREFIX) || text.length > 2048) continue;
        try {
            const payload = JSON.parse(text.slice(NOTICE_PREFIX.length));
            const previous = receiver.statuses(call.id).find(item => item.payload.sessionId === payload.sessionId)?.payload.event;
            const accepted = receiver.accept(message.author.id, preferences.trustedBotId, call.id, call.participants, payload, message.content ?? "");
            if (accepted) {
                changed();
                // Lease refreshes update state silently instead of creating a popup every 30 seconds.
                if (previous !== accepted.event) void showNotification({ title: "Call recording notice", body: message.content || `Recording state: ${accepted.event}`, noPersist: true });
            }
        } catch { /* Malformed notices are untrusted input. */ }
    }
}
export default definePlugin({
    name: "CallRecorder",
    description: "Experimental local incoming-call recorder with a chosen save folder, automatic labels and configurable notices.",
    authors: [{ name: "CallRecorder contributors", id: 0n }],
    tags: ["Voice", "Utility"],
    settingsAboutComponent: RecorderPanel,
    patches: [
        {
            // Same output-class anchor used by upstream VolumeBooster on web/Vesktop.
            find: "streamSourceNode",
            predicate: () => !IS_DISCORD_DESKTOP,
            replacement: { match: /\.volume=this\._volume\/100;/, replace: "$&$self.observeOutput(this);" }
        },
        {
            // CallTimer's upstream RTC header anchor. The dock remains available if this changes.
            find: '"RTCConnectionMenu"',
            replacement: { match: /("RTCConnectionMenu".{0,300}?lineClamp:1,children:)(\i)(?=,|}\))/, replace: "$1[$2,$self.renderControls()]" }
        }
    ],
    observeOutput(data: OutputData) {
        // Integration failures must never throw through Discord's playback path.
        try { const call = currentCall(); if (call) registry.observe(data, call.id); } catch { /* Fail closed at capture preflight. */ }
    },
    async finalizeForShutdown() { await controller.stop(false); },
    renderControls: ErrorBoundary.wrap(() => <Controls compact />, { noop: true }),
    async start() {
        try {
            await refresh();
            container = document.createElement("div"); document.body.append(container);
            root = createRoot(container); root.render(<ErrorBoundary><Dock /></ErrorBoundary>);
            timer = setInterval(() => controller.tick(), 750);
            checkpoints = setInterval(() => { void controller.checkpoint(); }, 10000);
            heartbeats = setInterval(() => {
                const session = controller.noticeSession();
                if (session) void Native.heartbeat(session).catch(error => {
                    setRuntimeError("Notice companion unavailable. Recipient recording status may become unknown.");
                    if (preferences.requireNotice && controller.phase === "recording") void controller.pause();
                });
            }, 20000);
            window.addEventListener("beforeunload", shutdown);
        } catch (error) { setRuntimeError(error instanceof Error ? error.message : String(error)); }
    },
    async stop() {
        if (timer) clearInterval(timer); if (checkpoints) clearInterval(checkpoints); if (heartbeats) clearInterval(heartbeats);
        window.removeEventListener("beforeunload", shutdown);
        await controller.stop(false);
        root?.unmount(); container?.remove(); root = undefined;
        registry.clear(); receiver.clear();
    },
    flux: {
        MESSAGE_CREATE({ message }) { receive(message); },
        MESSAGE_UPDATE({ message }) { receive(message); }
    }
});
