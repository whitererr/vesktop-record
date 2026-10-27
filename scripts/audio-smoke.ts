/** Synthetic browser integration test. This deliberately does not claim Discord capture works. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { RecordingStorage } from "../plugin/storage";
import { call } from "../tests/helpers";

const project = resolve(import.meta.dirname, "..");
const artifacts = resolve(project, ".cache/audio-smoke");
await mkdir(artifacts, { recursive: true });
const destination = join(artifacts, `recordings-${Date.now()}`); await mkdir(destination);
const store = new RecordingStorage(join(destination, "config"));
const methods: Record<string, (...args: any[]) => Promise<unknown>> = {
    status: () => store.status(), preferences: input => store.setPreferences(input),
    chooseFolder: () => store.selectFolder(destination), preflight: () => store.preflight(),
    begin: (call, notice) => store.begin(call, notice), append: (id, seq, bytes) => store.append(id, seq, new Uint8Array(bytes)),
    checkpoint: (id, duration, events, deliveries) => store.checkpoint(id, duration, events, deliveries),
    finish: (id, interrupted) => store.finish(id, interrupted), recordings: () => store.list(),
    readRecording: async id => Array.from(await store.read(id)), renameTitle: (id, title) => store.renameTitle(id, title)
};
const commonMock = `
import React from ${JSON.stringify(resolve(project, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(resolve(project, "node_modules/react-dom/client.js"))};
export {React,createRoot};
export const {useState,useEffect}=React;
export const SelectedChannelStore={getVoiceChannelId:()=>window.__call.id};
export const ChannelStore={getChannel:()=>({id:window.__call.id,type:2,guild_id:window.__call.guildId,name:window.__call.name})};
export const GuildStore={getGuild:()=>({name:window.__call.guildName})};
export const UserStore={getCurrentUser:()=>({id:window.__call.recorderId,username:window.__call.recorderName}),getUser:()=>null};
export const VoiceStateStore={isInChannel:()=>true,getVoiceStatesForChannel:()=>Object.fromEntries(window.__call.participants.map(userId=>[userId,{userId}]))};
export const MediaEngineStore={isSelfDeaf:()=>!!window.__deaf,isLocalMute:()=>!!window.__muted};
export function Modal(props){return React.createElement('div',{role:'dialog'},props.children)}
export function openModal(render){const div=document.createElement('div');document.body.append(div);const root=createRoot(div);root.render(render({onClose:()=>{root.unmount();div.remove()},transitionState:1}))}
`;
const bundle = await build({
    stdin: { contents: `
    (async()=>{
        window.VencordNative={pluginHelpers:{CallRecorder:new Proxy({},{get:(_,method)=>(...args)=>window.__native(method,args.map(arg=>arg instanceof Uint8Array?Array.from(arg):arg))})}};
        const runtime=await import('./plugin/runtime');
        const {RecorderPanel,Dock}=await import('./plugin/ui');
        const {React,createRoot}=await import('@webpack/common');
        await runtime.refresh();
        const context=new AudioContext(); const tone=context.createOscillator(); tone.frequency.value=440;
        const gain=context.createGain(); gain.gain.value=.15; tone.connect(gain);
        const output=context.createMediaStreamDestination(); gain.connect(output); tone.start(); await context.resume();
        runtime.registry.observe({id:window.__call.participants[1],stream:output.stream,_mute:false,_volume:100},window.__call.id);
        window.__runtime=runtime; window.__ownedTrack=output.stream.getAudioTracks()[0];
        createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(RecorderPanel),React.createElement(Dock)));
    })().catch(error=>window.__bootError=String(error));`, resolveDir: project, loader: "tsx" },
    bundle: true, write: false, format: "iife", platform: "browser", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
    plugins: [{ name: "discord-stores-test-double", setup(builder) {
        builder.onResolve({ filter: /^@webpack\/common$/ }, () => ({ path: "common", namespace: "test" }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: commonMock, loader: "js", resolveDir: project }));
    } }]
});
const host = createServer((_, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><html><body></body></html>"); });
await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${(host.address() as import("node:net").AddressInfo).port}`);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeBinding("__native", async (_, method: string, args: unknown[]) => {
        if (!methods[method]) throw new Error(`Unexpected native call: ${method}`);
        return methods[method](...args);
    });
    await page.setContent(`<html><head><style>body{background:#25262d;margin:24px;max-width:850px}${await readFile(resolve(project, "plugin/style.css"), "utf8")}</style></head><body><div id="root"></div></body></html>`);
    await page.evaluate(call => { (window as any).__call = call; }, call);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => (window as any).__runtime || (window as any).__bootError);
    assert.equal(await page.evaluate(() => (window as any).__bootError), undefined);
    await page.getByRole("button", { name: "settings", exact: true }).click();
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await page.getByText(destination, { exact: true }).waitFor();
    await page.getByLabel("I select incoming audio only").check();
    await page.getByLabel("Outgoing notices", { exact: true }).selectOption("off");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.waitForFunction(() => (window as any).__runtime.preferences.remoteOnly);
    await page.getByRole("button", { name: "record", exact: true }).click();
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    await page.waitForFunction(() => ["recording", "error"].includes((window as any).__runtime.controller.phase));
    assert.equal(await page.evaluate(() => (window as any).__runtime.controller.phase), "recording", await page.evaluate(() => (window as any).__runtime.controller.error));
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Pause", exact: true }).first().click();
    const pausedDuration = await page.evaluate(() => (window as any).__runtime.controller.durationMs);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => (window as any).__runtime.controller.durationMs), pausedDuration);
    await page.getByRole("button", { name: "Resume", exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.evaluate(() => { (window as any).__deaf = true; }); await page.waitForTimeout(500);
    await page.evaluate(() => { (window as any).__deaf = false; }); await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Stop", exact: true }).first().click();
    await page.waitForFunction(() => ["saved", "error", "interrupted"].includes((window as any).__runtime.controller.phase));
    assert.equal(await page.evaluate(() => (window as any).__runtime.controller.phase), "saved");
    assert.equal(await page.evaluate(() => (window as any).__ownedTrack.readyState), "live", "Discord-owned source track must survive cleanup");
    await page.getByRole("button", { name: "recordings", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => { const audio = document.querySelector("audio"); return audio && audio.readyState >= 2; });
    await page.waitForFunction(() => { const audio = document.querySelector("audio"); return audio && Number.isFinite(audio.duration) && audio.duration > 0; });
    await page.evaluate(() => { document.querySelector("audio")!.currentTime = 1; });
    await page.waitForFunction(() => { const audio = document.querySelector("audio"); return audio && !audio.seeking && audio.currentTime >= 1; });
    await page.screenshot({ path: join(artifacts, "recordings.png"), fullPage: true });
    assert.deepEqual(errors, []);
    const records = await store.list(); assert.equal(records.length, 1); assert.equal(records[0].status, "complete");
    const outputPath = await store.path(records[0].id);
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", outputPath, "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], { maxBuffer: 10 * 1024 * 1024 });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    const samples = new Float32Array(decoded.stdout.buffer.slice(decoded.stdout.byteOffset, decoded.stdout.byteOffset + decoded.stdout.length));
    const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length);
    const levels: number[] = [];
    for (let offset = 0; offset + 9600 < samples.length; offset += 9600) levels.push(rms(samples.slice(offset, offset + 9600)));
    assert.ok(Math.max(...levels) > 0.05, "Encoded audio must contain the generated tone");
    assert.ok(Math.min(...levels) < 0.005, "Deafen must produce a silent interval");
    assert.ok(samples.length / 48000 > 2 && samples.length / 48000 < 4.5, "Paused time must not extend the encoded recording");
    const report = { check: "synthetic browser audio + recorder UI + native storage", passed: true,
        durationSeconds: samples.length / 48000, bytes: records[0].bytes, filename: records[0].filename,
        minWindowRms: Math.min(...levels), maxWindowRms: Math.max(...levels), sourceTrackAfterCleanup: "live",
        realDiscordCallValidated: false };
    await writeFile(join(artifacts, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve())); }
