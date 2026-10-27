import { Modal, React, openModal, useEffect, useState } from "@webpack/common";
import { callLabel, errorText, noticeText, recordingStartLabel, type NoticeEvent, type Preferences, type Recording } from "./model";
import { Native, changed, controller, currentCall, folder, preferences, prompt, ready, receiver, refresh, registry, runtimeError, savePreferences, subscribe } from "./runtime";

export function useRecorder() {
    const [, update] = useState(0);
    useEffect(() => { const unsubscribe = subscribe(() => update(n => n + 1)); const timer = setInterval(() => update(n => n + 1), 200); return () => { unsubscribe(); clearInterval(timer); }; }, []);
}
function duration(ms: number) { return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`; }
export function Controls({ compact = false }: { compact?: boolean }) {
    useRecorder(); const call = currentCall(); const phase = controller.phase;
    const active = phase === "recording" || phase === "paused";
    const preparing = phase === "preparing" || phase === "countdown";
    return <div className={`cr-controls ${compact ? "cr-compact" : ""}`} aria-label="Call recorder">
        <span className={phase === "recording" ? "cr-rec" : ""} role="status">{phase === "recording" ? "● REC" : phase === "countdown" ? `Starting in ${controller.countdown}` : phase === "paused" ? "Paused" : "Call recorder"}</span>
        {active && <><span>{duration(controller.durationMs)}</span><meter min={0} max={1} value={controller.level} aria-label="Incoming recording level" />
            <button onClick={() => { void (phase === "paused" ? controller.resume() : controller.pause()); }}>{phase === "paused" ? "Resume" : "Pause"}</button>
            <button onClick={() => { void controller.stop(); }}>Stop</button></>}
        {preparing && <button onClick={() => { void controller.stop(); }}>Cancel</button>}
        {!active && !preparing && <button disabled={!call || !ready || phase === "stopping"} title={!call ? "Join a call to record" : "Review recording setup"} onClick={openRecorder}>{phase === "stopping" ? "Saving…" : "Record"}</button>}
        <button onClick={openRecorder} title="Recording settings and library">{compact ? "⋯" : "Settings & recordings"}</button>
        {controller.error && <span className="cr-error" role="alert">{compact ? "Check recorder" : controller.error}</span>}
    </div>;
}
export function Dock() {
    useRecorder(); const call = currentCall();
    const [dismissed, setDismissed] = useState<string[]>([]);
    const statuses = receiver.statuses(call?.id).filter(item => !dismissed.includes(item.payload.sessionId));
    return <div className="cr-dock">
        <Controls compact />
        {prompt && <div className="cr-notice" role="alert"><p>Send this notice in the call chat, then confirm.</p><p>{prompt.text}</p>
            <button onClick={() => { void navigator.clipboard.writeText(prompt!.text).catch(() => {}); }}>Copy notice</button>
            <button onClick={() => prompt?.resolve()}>I sent it</button><button onClick={() => { prompt?.reject(); void controller.stop(); }}>Cancel recording</button></div>}
        {statuses.map(item => <div className="cr-notice" role="status" key={item.payload.sessionId}>
            <strong>{item.state === "unknown" ? "Recording status unknown" : `Recording ${item.state}`}</strong>
            <p>{item.text}</p><button onClick={() => setDismissed(ids => [...ids, item.payload.sessionId])}>Dismiss</button>
        </div>)}
    </div>;
}
function Settings({ run }: { run: (work: () => Promise<unknown>) => void }) {
    const [draft, setDraft] = useState<Preferences>(() => structuredClone(preferences));
    const call = currentCall();
    const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft({ ...draft, [key]: value });
    return <div className="cr-settings">
        <h3>Recording</h3><p>Experimental incoming audio capture. Your own voice is unavailable until the transmitted-audio integration is verified. No raw microphone or desktop capture is used.</p>
        <label><input type="checkbox" checked={draft.remoteOnly} onChange={e => set("remoteOnly", e.target.checked)} /> I select incoming audio only</label>
        <h3>Storage</h3><p className="cr-path">{folder || "No folder selected"}</p>
        <button onClick={() => run(async () => { await Native.chooseFolder(); await refresh(); })}>{folder ? "Change folder" : "Choose folder"}</button>
        <button disabled={!folder} onClick={() => run(() => Native.revealFolder())}>Reveal folder</button>
        <p>The folder is remembered on this computer. Changes apply to the next recording. Existing recordings stay in their original folders.</p>
        <p>Filename: <code>YYYY-MM-DD_HH-mm-ss±HHMM__{call ? callLabel(call) : "Server__Channel"}__session.webm</code></p>
        <label>Stop new recordings at library size in MiB, 0 means unlimited <input type="number" min={0} value={draft.sizeLimitMb} onChange={e => set("sizeLimitMb", Number(e.target.value))} /></label>
        <h3>Automatic rules</h3><p>Only explicitly selected channel or conversation IDs record automatically. A manual Stop suppresses restart until you leave.</p>
        <label>Enabled IDs, one per line<textarea value={draft.autoChannels.join("\n")} onChange={e => set("autoChannels", e.target.value.split(/\s+/).filter(Boolean))} /></label>
        <button disabled={!call} onClick={() => { if (call) set("autoChannels", [...new Set([...draft.autoChannels, call.id])]); }}>Add current call</button>
        <h3>Notices</h3>
        <label>Outgoing notices <select aria-label="Outgoing notices" value={draft.noticeMode} onChange={e => set("noticeMode", e.target.value as Preferences["noticeMode"])}>
            <option value="manual">Manual copy and acknowledgement</option><option value="bot">Companion bot, server calls only</option><option value="off">Off</option></select></label>
        <label><input type="checkbox" checked={draft.requireNotice} onChange={e => set("requireNotice", e.target.checked)} /> Require configured notice success before capture</label>
        {draft.noticeMode === "off" && <p>Outgoing notices off. Other participants may not know recording is active. The local REC indicator stays visible.</p>}
        {(Object.keys(draft.templates) as NoticeEvent[]).map(event => <label key={event}>
            <span><input type="checkbox" checked={draft.noticeEvents[event]} onChange={e => setDraft({ ...draft, noticeEvents: { ...draft.noticeEvents, [event]: e.target.checked } })} /> {event}</span>
            <input value={draft.templates[event]} maxLength={1500} onChange={e => setDraft({ ...draft, templates: { ...draft.templates, [event]: e.target.value } })} />
        </label>)}
        <p>Variables: {"{recorder}, {call}, {time}, {duration}"}. Mentions are disabled.</p>
        <button onClick={() => run(async () => {
            const result = await Native.pairCompanion(); if (result) set("trustedBotId", result.botId);
        })}>Pair local companion</button>
        <label>Trusted notice bot ID <input value={draft.trustedBotId} onChange={e => set("trustedBotId", e.target.value)} /></label>
        <label><input type="checkbox" checked={draft.receivePopups} onChange={e => set("receivePopups", e.target.checked)} /> Receive verified server recording popups</label>
        <button className="cr-primary" onClick={() => run(() => savePreferences(draft))}>Save settings</button>
    </div>;
}
function Library({ run }: { run: (work: () => Promise<unknown>) => void }) {
    const [items, setItems] = useState<(Recording & { missing: boolean })[]>([]);
    const [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
    const reload = async () => { setItems(await Native.recordings()); };
    useEffect(() => { run(reload); }, []);
    useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);
    return <div><button onClick={() => run(reload)}>Refresh recordings</button>{!items.length && <p>No recordings yet.</p>}
        {items.map(record => <article className="cr-recording" key={record.id}>
            <h3>{record.title}</h3><p>{recordingStartLabel(record)} · {callLabel(record.call)}</p>
            <p>{duration(record.durationMs)} · {(record.bytes / 1048576).toFixed(1)} MiB · {record.missing ? "File missing or folder unavailable" : record.status} · Incoming audio only</p>
            {record.status !== "complete" && <p>Incomplete recording. Recovery and playback are not guaranteed. Export the partial file to attempt recovery.</p>}
            <button disabled={record.missing} onClick={() => run(async () => { const bytes = await Native.readRecording(record.id); setAudio({ id: record.id, url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: record.mime })) }); })}>Play</button>
            <button disabled={record.missing} onClick={() => run(() => Native.openExternally(record.id))}>Open externally</button>
            <button disabled={record.missing} onClick={() => run(() => Native.reveal(record.id))}>Reveal</button>
            <button disabled={record.missing} onClick={() => run(() => Native.exportRecording(record.id))}>Export</button>
            {record.missing && record.status === "complete" && <button onClick={() => run(async () => { await Native.locateRecording(record.id); await reload(); })}>Locate file</button>}
            <button onClick={() => { const title = window.prompt("Recording title", record.title); if (title) run(async () => { await Native.renameTitle(record.id, title); await reload(); }); }}>Rename title</button>
            <button onClick={() => run(async () => { await Native.removeRecording(record.id, !record.missing); await reload(); })}>{record.missing ? "Remove entry" : "Delete"}</button>
            {audio?.id === record.id && <audio src={audio.url} controls autoPlay aria-label={`Playback of ${record.title}`} onLoadedMetadata={event => {
                const element = event.currentTarget;
                // Chromium's MediaRecorder omits WebM duration. Probe the end once so controls can seek.
                if (element.duration === Infinity) {
                    element.addEventListener("timeupdate", () => { element.currentTime = 0; void element.play().catch(() => {}); }, { once: true });
                    element.currentTime = 1e10;
                }
            }} />}
        </article>)}
    </div>;
}
export function RecorderPanel() {
    useRecorder(); const [tab, setTab] = useState("record"); const [error, setError] = useState("");
    const run = (work: () => Promise<unknown>) => { setError(""); void work().catch(error => setError(errorText(error))); };
    const call = currentCall();
    return <div className="cr-panel">
        <nav aria-label="Recorder sections">{["record", "settings", "recordings", "diagnostics"].map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
        {(error || runtimeError) && <p className="cr-error" role="alert">{error || runtimeError}</p>}
        {tab === "record" && <><h3>{call ? callLabel(call) : "Join a call to record"}</h3>
            <p>Source: incoming audio only. Your own voice is excluded.</p><p>Save to: <span className="cr-path">{folder || "Choose a folder in settings"}</span></p>
            <p>Notice mode: {preferences.noticeMode}. {preferences.requireNotice ? "Configured notice required." : "Notice failures will be shown."}</p>
            {call && preferences.noticeMode !== "off" && <blockquote>{noticeText(preferences.templates.starting, call)}</blockquote>}
            <button className="cr-primary" disabled={!call || !ready || ["recording", "paused", "preparing", "countdown", "stopping"].includes(controller.phase)} onClick={() => run(() => controller.start())}>Start recording</button>
            <Controls />
            {controller.phase === "saved" && controller.record && <p>Saved. <button onClick={() => run(() => Native.openExternally(controller.record!.id))}>Open recording</button><button onClick={() => run(() => Native.reveal(controller.record!.id))}>Reveal in folder</button></p>}
        </>}
        {tab === "settings" && <Settings run={run} />}
        {tab === "recordings" && <Library run={run} />}
        {tab === "diagnostics" && <div><h3>Integration status</h3><p>Vencord source: 443688b5366a4d43e9868519f48a4544cd7520d4.</p>
            <p>Vesktop reference: 1.6.8. Real-call validation pending. Own voice, PTT and cross-platform support are unverified.</p>
            <p>Audio output hook observed {registry.hooksSeen} updates. Recognized current-call sources: {call ? registry.current(call.participants, call.recorderId, call.id).length : 0}.</p>
            <p>Encoder: {typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "WebM/Opus available" : "Unavailable"}. State: {controller.phase}.</p>
            <button onClick={() => run(() => Native.preflight())}>Test folder access</button><p>For a capture check, start a short recording with a speaking participant, stop, and play it from Recordings. A timer alone does not validate capture.</p>
            <button onClick={() => run(() => Native.exportDiagnostics({ phase: controller.phase, hookUpdates: registry.hooksSeen,
                sourceCount: call ? registry.current(call.participants, call.recorderId, call.id).length : 0,
                encoderSupported: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus") }))}>Export diagnostics</button>
            <p>Diagnostics exclude tokens, audio, message text, local file paths and participant identities.</p>
        </div>}
    </div>;
}
export function openRecorder() { openModal(props => <Modal {...props} title="Call recorder" subtitle="Local recordings · experimental Vencord userplugin" size="lg"><RecorderPanel /></Modal>); }
