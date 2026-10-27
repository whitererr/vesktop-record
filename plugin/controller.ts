import { errorText, noticeText } from "./model";
import type { CallInfo, NoticeEvent, Phase, Preferences, Recording } from "./model";
import type { Capture } from "./audio";

export interface RecorderNative {
    preflight(): Promise<void>;
    begin(call: CallInfo, notice: Recording["notice"]): Promise<Recording>;
    append(id: string, sequence: number, bytes: Uint8Array): Promise<void>;
    checkpoint(id: string, durationMs: number, events: Recording["events"], deliveries: Recording["deliveries"]): Promise<void>;
    finish(id: string, interrupted: boolean): Promise<Recording>;
}
export interface RecorderDependencies {
    native: RecorderNative;
    preferences(): Preferences;
    call(): CallInfo | null;
    capture(): Capture;
    notice(event: NoticeEvent, text: string, record: { id: string; call: CallInfo }): Promise<string>;
    manualNotice(text: string, signal: AbortSignal): Promise<void>;
    countdown(signal: AbortSignal, tick: (seconds: number) => void): Promise<void>;
    changed(): void;
}

export class SessionController {
    phase: Phase = "idle";
    error = "";
    countdown = 0;
    record?: Recording;
    suppressAutoFor?: string;
    private capture?: Capture;
    private abort?: AbortController;
    private startTask?: Promise<void>;
    private stopTask?: Promise<void>;
    private actionTail: Promise<void> = Promise.resolve();
    private diskTail: Promise<void> = Promise.resolve();
    private queuedBytes = 0;
    private sequence = 0;
    private elapsed = 0;
    private resumedAt = 0;
    private interrupted = false;
    private sessionPreferences?: Preferences;
    private startingCall?: CallInfo;
    private noticeSessionId = "";
    private pendingDeliveries: Recording["deliveries"] = [];
    private knownParticipants = new Set<string>();
    private arrivalTask?: Promise<void>;
    private failedCallId?: string;
    constructor(private readonly deps: RecorderDependencies) { }
    get durationMs(): number { return this.elapsed + (this.phase === "recording" ? performance.now() - this.resumedAt : 0); }
    get level(): number { return this.phase === "recording" ? this.capture?.level() ?? 0 : 0; }
    private setPhase(phase: Phase) { this.phase = phase; this.deps.changed(); }
    private ensureCurrent(signal: AbortSignal) {
        if (signal.aborted || this.deps.call()?.id !== this.startingCall?.id) throw new Error("Recording start cancelled or call changed.");
    }
    start(automatic = false): Promise<void> {
        if (["preparing", "countdown", "recording", "paused", "stopping"].includes(this.phase)) return this.startTask ?? Promise.resolve();
        this.error = ""; this.record = undefined; this.interrupted = false; this.elapsed = 0; this.sequence = 0; this.diskTail = Promise.resolve();
        this.abort = new AbortController(); this.startingCall = this.deps.call() ?? undefined;
        this.sessionPreferences = structuredClone(this.deps.preferences());
        this.noticeSessionId = crypto.randomUUID(); this.pendingDeliveries = [];
        this.setPhase("preparing");
        const signal = this.abort.signal;
        this.startTask = this.prepare(automatic, signal).catch(async error => {
            if (this.record) {
                await this.deps.native.finish(this.record.id, true).catch(() => {});
            }
            await this.capture?.close().catch(() => {}); this.capture = undefined;
            this.error = signal.aborted ? "" : errorText(error);
            this.failedCallId = this.startingCall?.id;
            this.setPhase(signal.aborted ? "idle" : "error");
        }).finally(() => { this.startTask = undefined; });
        return this.startTask;
    }
    private async prepare(automatic: boolean, signal: AbortSignal): Promise<void> {
        const call = this.startingCall;
        if (!call) throw new Error("Join a call before recording.");
        const prefs = this.sessionPreferences!;
        if (automatic && (!prefs.autoChannels.includes(call.id) || this.suppressAutoFor === call.id || !call.participants.some(id => id !== call.recorderId))) throw new Error("This call is not eligible for automatic recording.");
        if (!prefs.remoteOnly) throw new Error("Select Incoming audio only in Recording settings. Own transmitted voice has not passed the integration gate and is unavailable.");
        await this.deps.native.preflight(); this.ensureCurrent(signal);
        this.capture = this.deps.capture(); await this.capture.prepare(); this.ensureCurrent(signal);
        this.knownParticipants = new Set(call.participants);
        await this.deliver("starting", signal); this.ensureCurrent(signal);
        // Manual starts with notices off need no countdown. Automatic starts always allow Cancel.
        if (prefs.noticeMode !== "off" || automatic) {
            this.setPhase("countdown");
            await this.deps.countdown(signal, value => { this.countdown = value; this.deps.changed(); });
        }
        this.ensureCurrent(signal);
        const freshCall = this.deps.call()!;
        if (freshCall.participants.some(id => !this.knownParticipants.has(id))) throw new Error("Participants changed during the start notice. Start again to notify the current call.");
        this.record = await this.deps.native.begin(freshCall, { mode: prefs.noticeMode, required: prefs.requireNotice });
        this.record.deliveries.push(...this.pendingDeliveries);
        this.ensureCurrent(signal);
        // Keep the notice protocol ID stable across pre-capture and active events.
        this.record.events.push({ type: "notice-session", at: new Date().toISOString(), detail: this.noticeSessionId });
        this.resumedAt = performance.now();
        this.capture.start(chunk => this.write(chunk), error => { void this.stop(false, errorText(error)); });
        this.setPhase("recording");
        try { await this.deliver("started", signal); }
        catch (error) {
            this.pauseCapture(); this.error = errorText(error); this.setPhase("paused");
        }
    }
    private async deliver(event: NoticeEvent, signal?: AbortSignal): Promise<void> {
        const prefs = this.sessionPreferences!;
        if (!prefs || !prefs.noticeEvents[event] || prefs.noticeMode === "off") return;
        const call = this.startingCall!;
        const text = noticeText(prefs.templates[event], call, this.durationMs);
        let outcome: string;
        try {
            if (prefs.noticeMode === "manual") {
                // A fresh manual acknowledgement is required for start/resume and arrivals.
                if (["starting", "resumed", "arrival"].includes(event)) {
                    await this.deps.manualNotice(text, signal ?? this.abort!.signal);
                    outcome = "Manual notice acknowledged";
                } else outcome = "Manual follow-up available to copy; not automatically delivered";
            } else outcome = await this.deps.notice(event, text, { id: this.noticeSessionId, call });
        } catch (error) {
            outcome = `Delivery failed: ${errorText(error)}`;
            (this.record?.deliveries ?? this.pendingDeliveries).push({ event, at: new Date().toISOString(), outcome });
            this.error = outcome; this.deps.changed();
            if (prefs.requireNotice) throw error;
            return;
        }
        (this.record?.deliveries ?? this.pendingDeliveries).push({ event, at: new Date().toISOString(), outcome });
    }
    private write(blob: Blob): void {
        if (!this.record || this.interrupted) return;
        this.queuedBytes += blob.size;
        if (this.queuedBytes > 16 * 1024 * 1024) { this.queuedBytes -= blob.size; void this.stop(false, "Disk writes cannot keep up. Partial recording retained."); return; }
        const id = this.record.id;
        const task = this.diskTail.then(async () => {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            for (let offset = 0; offset < bytes.length; offset += 2 * 1024 * 1024) await this.deps.native.append(id, this.sequence++, bytes.subarray(offset, offset + 2 * 1024 * 1024));
            this.record!.bytes += bytes.length;
        });
        this.diskTail = task.catch(error => { this.interrupted = true; this.error = errorText(error); queueMicrotask(() => { void this.stop(false, this.error); }); })
            .finally(() => { this.queuedBytes -= blob.size; });
    }
    private pauseCapture(): void {
        if (this.phase !== "recording") return;
        this.elapsed = this.durationMs; this.capture?.pause();
        this.record?.events.push({ type: "pause", at: new Date().toISOString() });
        this.setPhase("paused");
    }
    private action(work: () => Promise<void>): Promise<void> {
        const task = this.actionTail.then(work).catch(error => { this.error = errorText(error); this.deps.changed(); });
        this.actionTail = task; return task;
    }
    pause(): Promise<void> {
        this.pauseCapture();
        return this.action(async () => { if (this.phase === "paused") await this.deliver("paused"); });
    }
    resume(): Promise<void> {
        return this.action(async () => {
            if (this.phase !== "paused") return;
            const participants = new Set(this.deps.call()?.participants ?? []);
            await this.deliver("resumed");
            if (this.phase !== "paused" || this.abort?.signal.aborted || this.deps.call()?.id !== this.startingCall?.id) return;
            if (this.sessionPreferences!.noticeMode !== "off") await this.deps.countdown(this.abort!.signal, value => { this.countdown = value; this.deps.changed(); });
            if (this.phase !== "paused" || this.abort?.signal.aborted) return;
            if (this.deps.call()?.participants.some(id => !participants.has(id))) throw new Error("Participants changed during the notice. Retry Resume to notify the current call.");
            this.capture?.resume(); this.resumedAt = performance.now();
            this.record?.events.push({ type: "resume", at: new Date().toISOString() });
            this.error = ""; this.setPhase("recording");
        });
    }
    stop(manual = true, reason = ""): Promise<void> {
        if (manual) this.suppressAutoFor = this.startingCall?.id;
        this.abort?.abort();
        if (this.stopTask) return this.stopTask;
        this.stopTask = (async () => {
            await this.startTask;
            if (!this.record || !["recording", "paused"].includes(this.phase)) return;
            if (this.phase === "recording") this.elapsed = this.durationMs;
            this.interrupted ||= Boolean(reason);
            this.setPhase("stopping");
            try { await this.capture?.stop(); } catch (error) { this.interrupted = true; reason ||= errorText(error); }
            await this.diskTail;
            try {
                if (reason) this.record.events.push({ type: "interruption", at: new Date().toISOString(), detail: reason });
                await this.deps.native.checkpoint(this.record.id, this.elapsed, this.record.events, this.record.deliveries);
                this.record = await this.deps.native.finish(this.record.id, this.interrupted);
                await this.deliver("stopped").catch(error => { this.error = errorText(error); });
                await this.deps.native.checkpoint(this.record.id, this.elapsed, this.record.events, this.record.deliveries);
                this.error = reason || this.error; this.setPhase(this.record.status === "complete" ? "saved" : "interrupted");
            } catch (error) {
                await this.deps.native.finish(this.record.id, true).catch(() => {});
                this.error = errorText(error); this.setPhase("error");
            } finally { await this.capture?.close().catch(() => {}); this.capture = undefined; }
        })().finally(() => { this.stopTask = undefined; });
        return this.stopTask;
    }
    async checkpoint(): Promise<void> {
        if (this.record && ["recording", "paused"].includes(this.phase)) {
            try { await this.deps.native.checkpoint(this.record.id, this.durationMs, this.record.events, this.record.deliveries); }
            catch (error) { await this.stop(false, errorText(error)); }
        }
    }
    tick(): void {
        const call = this.deps.call();
        if (this.phase === "error" && (!call || call.id !== this.failedCallId)) { this.failedCallId = undefined; this.setPhase("idle"); }
        if (this.suppressAutoFor && call?.id !== this.suppressAutoFor) this.suppressAutoFor = undefined;
        if (["preparing", "countdown", "recording", "paused"].includes(this.phase)) {
            if (call?.id !== this.startingCall?.id || !call?.participants.some(id => id !== call.recorderId)) {
                this.record?.events.push({ type: "call-ended", at: new Date().toISOString() });
                void this.stop(false); return;
            }
            const arrivals = call.participants.filter(id => !this.knownParticipants.has(id));
            if (this.phase === "recording" || this.phase === "paused") this.knownParticipants = new Set(call.participants);
            if (arrivals.length && this.phase === "recording" && !this.arrivalTask && this.sessionPreferences?.noticeMode !== "off" && this.sessionPreferences?.noticeEvents.arrival) {
                this.pauseCapture();
                this.arrivalTask = this.action(async () => {
                    const notified = new Set(this.deps.call()?.participants ?? []);
                    await this.deliver("arrival");
                    if (this.phase === "paused" && !this.abort?.signal.aborted) {
                        await this.deps.countdown(this.abort!.signal, () => {});
                        if (this.deps.call()?.participants.some(id => !notified.has(id))) throw new Error("More participants joined during the notice. Resume to notify the current call.");
                        if (this.phase === "paused" && !this.abort?.signal.aborted) { this.capture?.resume(); this.resumedAt = performance.now(); this.setPhase("recording"); }
                    }
                }).finally(() => { this.arrivalTask = undefined; });
            }
        } else if (call && !this.stopTask && this.phase !== "error" && this.deps.preferences().autoChannels.includes(call.id)
            && call.id !== this.suppressAutoFor && call.participants.some(id => id !== call.recorderId)) void this.start(true);
    }
    updatePreferences(): void {
        // Explicit changes apply to the notice policy now; source and destination stay fixed.
        if (this.sessionPreferences) {
            const prefs = this.deps.preferences();
            this.sessionPreferences = { ...this.sessionPreferences, noticeMode: prefs.noticeMode, requireNotice: prefs.requireNotice,
                templates: structuredClone(prefs.templates), noticeEvents: structuredClone(prefs.noticeEvents) };
            this.record?.events.push({ type: "notice-settings-changed", at: new Date().toISOString() });
        }
        this.deps.changed();
    }
    noticeSession(): { id: string; call: CallInfo } | null {
        return ["recording", "paused"].includes(this.phase) && this.sessionPreferences?.noticeMode === "bot" && this.startingCall
            ? { id: this.noticeSessionId, call: this.startingCall } : null;
    }
}
