export interface OutputData {
    id: string;
    userId?: string;
    stream: MediaStream;
    videoStreamId?: string;
    audioElement?: HTMLAudioElement;
    _mute: boolean;
    _volume: number;
}
export interface Capture {
    prepare(): Promise<void>;
    start(onChunk: (chunk: Blob) => void, onFailure: (error: Error) => void): void;
    pause(): void;
    resume(): void;
    stop(): Promise<void>;
    close(): Promise<void>;
    level(): number;
}
/** Observes decoded client outputs; never opens a microphone or desktop source. */
export class OutputRegistry {
    readonly outputs = new Map<string, OutputData>();
    private channels = new Map<string, string | undefined>();
    hooksSeen = 0;
    observe(data: OutputData, channelId?: string): void {
        this.hooksSeen++;
        if (!data || typeof data.id !== "string" || !data.stream?.getAudioTracks) return;
        const tracks = data.stream.getAudioTracks();
        // Screenshare and video outputs are deliberately excluded.
        if (data.videoStreamId || !tracks.length || data.stream.getVideoTracks().length) return;
        this.outputs.set(data.id, data);
        this.channels.set(data.id, channelId);
    }
    current(participants: string[], selfId: string, channelId?: string): OutputData[] {
        for (const [id, data] of this.outputs) if (!data.stream.getAudioTracks().some(t => t.readyState === "live")) this.outputs.delete(id);
        return [...this.outputs.values()].filter(data => {
            const userId = data.userId ?? data.id;
            return userId !== selfId && participants.includes(userId) && (!channelId || this.channels.get(data.id) === channelId);
        });
    }
    clear() { this.outputs.clear(); this.channels.clear(); }
}

export class RemoteCapture implements Capture {
    private context?: AudioContext;
    private destination?: MediaStreamAudioDestinationNode;
    private analyser?: AnalyserNode;
    private recorder?: MediaRecorder;
    private nodes = new Map<string, { stream: MediaStream; source: MediaStreamAudioSourceNode; gain: GainNode }>();
    private timer?: ReturnType<typeof setInterval>;
    private failure?: (error: Error) => void;
    private hadSource = false;
    private lostAt = 0;
    constructor(private readonly registry: OutputRegistry,
        private readonly state: () => { participants: string[]; selfId: string; channelId?: string; deaf: boolean; muted: (id: string) => boolean }) { }

    async prepare(): Promise<void> {
        if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) throw new Error("This runtime does not support WebM/Opus recording.");
        const state = this.state();
        if (!this.registry.current(state.participants, state.selfId, state.channelId).length) throw new Error("No verified incoming voice output found. Rejoin the call and have another participant speak. This Discord build may need an updated audio adapter.");
        this.context = new AudioContext();
        this.destination = this.context.createMediaStreamDestination();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 512;
        // The mix is connected only to a recording destination and meter, never speakers.
        await this.context.resume();
        this.sync();
        this.timer = setInterval(() => this.sync(), 50);
    }
    private sync(): void {
        if (!this.context || !this.destination || !this.analyser) return;
        try {
            const state = this.state();
            const outputs = this.registry.current(state.participants, state.selfId, state.channelId);
            const ids = new Set(outputs.map(data => data.id));
            for (const [id, node] of this.nodes) if (!ids.has(id)) { node.source.disconnect(); node.gain.disconnect(); this.nodes.delete(id); }
            for (const data of outputs) {
                let node = this.nodes.get(data.id);
                if (node && node.stream !== data.stream) { node.source.disconnect(); node.gain.disconnect(); this.nodes.delete(data.id); node = undefined; }
                if (!node) {
                    const source = this.context.createMediaStreamSource(new MediaStream(data.stream.getAudioTracks()));
                    const gain = this.context.createGain(); source.connect(gain); gain.connect(this.destination); gain.connect(this.analyser);
                    node = { stream: data.stream, source, gain }; this.nodes.set(data.id, node);
                }
                const muted = state.deaf || state.muted(data.userId ?? data.id) || data._mute || data.audioElement?.muted;
                node.gain.gain.value = muted ? 0 : Math.min(4, Math.max(0, Number.isFinite(data._volume) ? data._volume / 100 : 0));
            }
            if (outputs.length) { this.hadSource = true; this.lostAt = 0; }
            else if (this.hadSource && !this.lostAt) this.lostAt = performance.now();
            else if (this.lostAt && performance.now() - this.lostAt > 5000) {
                this.failure?.(new Error("Incoming audio tracks ended. Recording interrupted.")); this.lostAt = 0; this.hadSource = false;
            }
        } catch (error) { this.failure?.(error instanceof Error ? error : new Error(String(error))); }
    }
    start(onChunk: (chunk: Blob) => void, onFailure: (error: Error) => void): void {
        if (!this.destination || !this.context || this.context.state !== "running") throw new Error("Audio capture is not initialized.");
        this.failure = onFailure;
        this.recorder = new MediaRecorder(this.destination.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 96000 });
        this.recorder.ondataavailable = event => { if (event.data.size) onChunk(event.data); };
        this.recorder.onerror = () => onFailure(new Error("The audio encoder failed."));
        this.recorder.start(1000);
    }
    pause(): void { if (this.recorder?.state === "recording") this.recorder.pause(); }
    resume(): void { if (this.recorder?.state === "paused") this.recorder.resume(); }
    async stop(): Promise<void> {
        const recorder = this.recorder;
        if (!recorder || recorder.state === "inactive") return;
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Encoder did not finalize. Partial data retained.")), 10000);
            recorder.addEventListener("stop", () => { clearTimeout(timeout); resolve(); }, { once: true });
            recorder.stop();
        });
    }
    async close(): Promise<void> {
        this.failure = undefined;
        if (this.timer) clearInterval(this.timer);
        for (const node of this.nodes.values()) { node.source.disconnect(); node.gain.disconnect(); }
        this.nodes.clear(); this.analyser?.disconnect();
        // Only the plugin-owned mix track is stopped. Discord-owned tracks are untouched.
        this.destination?.stream.getTracks().forEach(track => track.stop());
        await this.context?.close();
        this.context = undefined;
    }
    level(): number {
        if (!this.analyser) return 0;
        const samples = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(samples);
        return Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 3);
    }
}
