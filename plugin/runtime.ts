import { ChannelStore, GuildStore, MediaEngineStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";
import type { PluginNative } from "@utils/types";
import { OutputRegistry, RemoteCapture } from "./audio";
import { SessionController } from "./controller";
import { defaults } from "./model";
import type { CallInfo, Preferences } from "./model";
import { NoticeReceiver } from "./notices";

export const Native = VencordNative.pluginHelpers.CallRecorder as PluginNative<typeof import("./native")>;
export const registry = new OutputRegistry();
export const receiver = new NoticeReceiver();
export let preferences: Preferences = structuredClone(defaults);
export let folder: string | null = null;
export let ready = false;
export let runtimeError = "";
const listeners = new Set<() => void>();
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function changed() { for (const listener of listeners) listener(); }
export function currentCall(): CallInfo | null {
    const id = SelectedChannelStore.getVoiceChannelId();
    if (!id) return null;
    const channel = ChannelStore.getChannel(id);
    const user = UserStore.getCurrentUser();
    if (!channel || !user || !VoiceStateStore.isInChannel(id, user.id)) return null;
    const participants = Object.values(VoiceStateStore.getVoiceStatesForChannel(id)).map(state => state.userId);
    if (!participants.includes(user.id)) participants.push(user.id);
    const kind = channel.guild_id ? "server" : channel.type === 1 ? "dm" : "group";
    const other = kind === "dm" ? UserStore.getUser(channel.recipients?.find(id => id !== user.id) ?? "") : undefined;
    return {
        id, kind, name: kind === "dm" ? other?.globalName || other?.username || channel.recipients?.[0] || id : channel.name || id,
        guildId: channel.guild_id || undefined, guildName: channel.guild_id ? GuildStore.getGuild(channel.guild_id)?.name : undefined,
        recorderId: user.id, recorderName: user.globalName || user.username, participants
    };
}
export type ManualPrompt = { text: string; resolve(): void; reject(): void };
export let prompt: ManualPrompt | null = null;
export const controller = new SessionController({
    native: Native,
    preferences: () => preferences,
    call: currentCall,
    capture: () => new RemoteCapture(registry, () => {
        const call = currentCall();
        return { participants: call?.participants ?? [], selfId: call?.recorderId ?? "", channelId: call?.id, deaf: MediaEngineStore.isSelfDeaf(),
            muted: id => MediaEngineStore.isLocalMute(id) };
    }),
    notice: (event, text, session) => Native.sendNotice(event, text, session),
    manualNotice: (text, signal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error("Cancelled.")); return; }
        const abort = () => { prompt = null; changed(); reject(new Error("Notice step cancelled.")); };
        signal.addEventListener("abort", abort, { once: true });
        prompt = { text, resolve() { signal.removeEventListener("abort", abort); prompt = null; changed(); resolve(); },
            reject() { signal.removeEventListener("abort", abort); abort(); } };
        changed();
    }),
    async countdown(signal, tick) {
        for (let remaining = 3; remaining > 0; remaining--) {
            if (signal.aborted) throw new Error("Cancelled.");
            tick(remaining);
            await new Promise<void>((resolve, reject) => {
                const abort = () => { clearTimeout(timer); reject(new Error("Cancelled.")); };
                const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    },
    changed
});
export async function refresh(): Promise<void> {
    const status = await Native.status(); preferences = status.preferences; folder = status.folder; ready = true; changed();
}
export async function savePreferences(value: Preferences): Promise<void> {
    await Native.preferences(value); preferences = structuredClone(value); controller.updatePreferences(); changed();
}
export function setRuntimeError(error: string) { runtimeError = error; changed(); }
