import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionController } from "../plugin/controller";
import type { Capture } from "../plugin/audio";
import { defaults } from "../plugin/model";
import type { CallInfo, Preferences } from "../plugin/model";
import { fixture, call as baseCall } from "./helpers";

class CaptureFake implements Capture {
    onChunk?: (chunk: Blob) => void;
    closed = false; paused = false;
    async prepare() {}
    start(chunk: (blob: Blob) => void) { this.onChunk = chunk; this.onChunk(new Blob([new Uint8Array([1, 2])])); }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    async stop() { this.onChunk?.(new Blob([new Uint8Array([3, 4])])); }
    async close() { this.closed = true; }
    level() { return 0.5; }
}
async function setup() {
    const { store } = await fixture(); const capture = new CaptureFake();
    let call: CallInfo | null = structuredClone(baseCall);
    let prefs: Preferences = { ...structuredClone(defaults), remoteOnly: true, noticeMode: "off" };
    const deliveries: string[] = [];
    const deps = { native: store, preferences: () => prefs, call: () => call, capture: () => capture,
        notice: async (event: string) => { deliveries.push(event); return "Chat notice posted"; }, manualNotice: async () => {},
        countdown: async (_: AbortSignal, tick: (n: number) => void) => { tick(3); }, changed() {} };
    const controller = new SessionController(deps);
    return { store, capture, controller, deps, deliveries, setCall(value: CallInfo | null) { call = value; }, setPrefs(value: Partial<Preferences>) { prefs = { ...prefs, ...value }; } };
}
test("controller serializes repeated start and stop, including the encoder's final chunk", async () => {
    const { controller, store, capture } = await setup();
    await Promise.all([controller.start(), controller.start()]); assert.equal(controller.phase, "recording");
    await Promise.all([controller.stop(), controller.stop()]);
    assert.equal(controller.phase, "saved"); assert.equal((await store.list()).length, 1);
    assert.deepEqual([...await store.read(controller.record!.id)], [1, 2, 3, 4]); assert.equal(capture.closed, true);
});
test("incoming-only source must be explicitly selected", async () => {
    const { controller, setPrefs, store } = await setup(); setPrefs({ remoteOnly: false });
    await controller.start(); assert.equal(controller.phase, "error"); assert.match(controller.error, /Incoming audio only/); assert.equal((await store.list()).length, 0);
});
test("cancel interrupts countdown and never opens a recording", async () => {
    const { controller, deps, store, capture, setPrefs } = await setup(); setPrefs({ noticeMode: "bot" });
    let entered!: () => void; const countdown = new Promise<void>(resolve => { entered = resolve; });
    deps.countdown = (signal: AbortSignal) => new Promise<void>((_, reject) => { entered(); signal.addEventListener("abort", () => reject(new Error("cancel")), { once: true }); });
    const start = controller.start(); await countdown; await controller.stop(); await start;
    assert.equal(controller.phase, "idle"); assert.equal((await store.list()).length, 0); assert.equal(capture.closed, true);
});
test("pause excludes duration and duplicate resume actions are serialized", async () => {
    const { controller, capture } = await setup(); await controller.start();
    await controller.pause(); assert.equal(controller.phase, "paused"); const elapsed = controller.durationMs;
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(controller.durationMs, elapsed);
    assert.equal(capture.paused, true); await Promise.all([controller.resume(), controller.resume()]); assert.equal(controller.phase, "recording");
    await controller.stop(); assert.equal(controller.record!.events.filter(event => event.type === "resume").length, 1);
});
test("required failed notice blocks start, optional failed notice records actual failure", async () => {
    const env = await setup(); env.setPrefs({ noticeMode: "bot" }); env.deps.notice = async () => { throw new Error("offline"); };
    await env.controller.start(); assert.equal(env.controller.phase, "error"); assert.equal((await env.store.list()).length, 0);
    env.setPrefs({ requireNotice: false }); await env.controller.start(); assert.equal(env.controller.phase, "recording");
    await env.controller.stop(); assert.ok(env.controller.record!.deliveries.some(delivery => delivery.outcome.includes("offline")));
});
test("notices off makes no calls and sends no late-arrival event", async () => {
    const env = await setup(); env.deps.manualNotice = async () => { throw new Error("must not ask"); };
    await env.controller.start(); env.setCall({ ...baseCall, participants: [...baseCall.participants, "56789012345678901"] });
    env.controller.tick(); await env.controller.pause(); await env.controller.resume(); await env.controller.stop(); assert.deepEqual(env.deliveries, []);
});
test("manual Stop suppresses automatic restart until the call is left", async () => {
    const env = await setup(); env.setPrefs({ autoChannels: [baseCall.id] }); await env.controller.start(true); await env.controller.stop();
    env.controller.tick(); assert.equal(env.controller.phase, "saved"); assert.equal(env.controller.suppressAutoFor, baseCall.id);
    env.setCall(null); env.controller.tick(); assert.equal(env.controller.suppressAutoFor, undefined);
});
test("normal leave finalizes playable-container bytes rather than labelling a crash", async () => {
    const env = await setup(); await env.controller.start(); env.setCall(null); env.controller.tick(); await env.controller.stop(false);
    assert.equal(env.controller.phase, "saved");
});
test("failed append retains interrupted status instead of Saved", async () => {
    const env = await setup();
    // Use a narrow proxy to preserve the native storage methods and inject disk failure.
    env.deps.native = new Proxy(env.store, { get(target, prop) { return prop === "append" ? async () => { throw new Error("disk full"); } : typeof (target as any)[prop] === "function" ? (target as any)[prop].bind(target) : (target as any)[prop]; } });
    await env.controller.start(); await new Promise(resolve => setTimeout(resolve, 10)); await env.controller.stop(false);
    assert.notEqual(env.controller.phase, "saved"); assert.equal((await env.store.list())[0].status, "interrupted");
});
test("new participant during start countdown forces a fresh notice before capture", async () => {
    const env = await setup(); env.setPrefs({ noticeMode: "bot" });
    env.deps.countdown = async () => { env.setCall({ ...baseCall, participants: [...baseCall.participants, "56789012345678901"] }); env.controller.tick(); };
    await env.controller.start(); assert.equal(env.controller.phase, "error"); assert.match(env.controller.error, /Participants changed/); assert.equal((await env.store.list()).length, 0);
});
