import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, unlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStorage } from "../plugin/storage";
import { defaults, filename, safeName } from "../plugin/model";
import { call, fixture } from "./helpers";
const notice = { mode: "off", required: false } as const;
test("labels include call location, timezone, stable suffix and actual extension", () => {
    const date = new Date("2026-10-26T19:30:05Z");
    const name = filename(call, date, "a1b2c3d4-1234-1234-1234-123456789012");
    assert.match(name, /^2026-10-26_\d{2}-30-05[+-]\d{4}__Friends__General__a1b2c3d4\.webm$/);
    assert.match(filename({ ...call, kind: "dm", name: "Alex" }, date, "abcdef12"), /__DM__Alex__/);
    assert.match(filename({ ...call, kind: "group", name: "" }, date, "abcdef12"), /__Group-DM__12345678901234567__/);
    assert.equal(safeName("../bad\\file:*?" ).includes("/"), false);
    assert.equal(safeName("CON"), "Call");
    assert.equal(safeName("..."), "Call");
    assert.equal(safeName("声の部屋"), "声の部屋");
    assert.ok(Buffer.byteLength(safeName("😀".repeat(300))) <= 70);
});
test("folder persists, ordered chunks stream to disk, sidecar matches and finish is truthful", async () => {
    const { store, folder, config } = await fixture();
    const record = await store.begin(call, notice);
    await Promise.all([store.append(record.id, 0, new Uint8Array([1, 2])), store.append(record.id, 1, new Uint8Array([3, 4]))]);
    await store.checkpoint(record.id, 2345, [{ type: "pause", at: new Date().toISOString() }], []);
    const saved = await store.finish(record.id);
    assert.equal(saved.status, "complete"); assert.equal(saved.bytes, 4);
    assert.deepEqual([...await store.read(record.id)], [1, 2, 3, 4]);
    assert.equal((await stat(join(folder, saved.filename))).mode & 0o777, 0o600);
    const sidecar = JSON.parse(await readFile(join(folder, saved.filename.replace(/\.webm$/, ".json")), "utf8"));
    assert.equal(sidecar.durationMs, 2345); assert.equal(sidecar.call.name, "General"); assert.equal(sidecar.status, "complete");
    const restarted = new RecordingStorage(config);
    assert.equal((await restarted.status()).folder, folder);
    assert.equal((await restarted.list())[0].status, "complete");
    assert.equal((await readdir(folder)).some(name => name.endsWith(".partial")), false);
});
test("folder changes apply to next session while preserving the active destination and old library", async () => {
    const { store, base, folder } = await fixture();
    const first = await store.begin(call, notice); const secondFolder = join(base, "new"); await mkdir(secondFolder);
    await store.selectFolder(secondFolder);
    await store.append(first.id, 0, new Uint8Array([1])); await store.finish(first.id);
    const second = await store.begin(call, notice);
    await store.append(second.id, 0, new Uint8Array([2])); await store.finish(second.id);
    assert.ok((await readdir(folder)).includes(first.filename)); assert.ok((await readdir(secondFolder)).includes(second.filename));
    assert.notEqual(first.filename, second.filename); assert.equal((await store.list()).filter(record => !record.missing).length, 2);
});
test("rejects duplicate allocation, out-of-order writes and oversized chunks", async () => {
    const { store } = await fixture();
    const requests = await Promise.allSettled([store.begin(call, notice), store.begin(call, notice)]);
    assert.equal(requests.filter(result => result.status === "fulfilled").length, 1);
    const record = (requests.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof store.begin>>>).value;
    await assert.rejects(store.append(record.id, 1, new Uint8Array([1])), /Out-of-order/);
    await assert.rejects(store.append(record.id, 0, new Uint8Array(2 * 1024 * 1024 + 1)), /chunk size/);
    await store.finish(record.id, true);
});
test("finalization cannot overwrite a preexisting file", async () => {
    const { store, folder } = await fixture(); const record = await store.begin(call, notice);
    await store.append(record.id, 0, new Uint8Array([1]));
    await writeFile(join(folder, record.filename), "keep me");
    await assert.rejects(store.finish(record.id));
    assert.equal(await readFile(join(folder, record.filename), "utf8"), "keep me");
    assert.deepEqual([...await readFile(join(folder, record.filename + ".partial"))], [1]);
    assert.equal((await store.list())[0].status, "interrupted");
});
test("unavailable and substituted recording folders block writes", async () => {
    const { store, folder, base } = await fixture();
    await rename(folder, folder + "-original"); await mkdir(join(base, "elsewhere")); await symlink(join(base, "elsewhere"), folder);
    await assert.rejects(store.preflight(), /folder changed/);
    await assert.rejects(store.begin(call, notice));
    assert.deepEqual(await readdir(join(base, "elsewhere")), []);
});
test("symlinked output cannot be read or finalized", async () => {
    const { store, folder, base } = await fixture(); const record = await store.begin(call, notice);
    const outside = join(base, "outside"); await writeFile(outside, "private");
    await unlink(join(folder, record.filename + ".partial")); await symlink(outside, join(folder, record.filename + ".partial"));
    await assert.rejects(store.read(record.id), /regular file/);
    await store.append(record.id, 0, new Uint8Array([7]));
    await assert.rejects(store.finish(record.id), /replaced/);
    assert.equal(await readFile(outside, "utf8"), "private");
});
test("empty and interrupted sessions never claim complete; restart exposes recovery data", async () => {
    const { store, config } = await fixture(); const record = await store.begin(call, notice);
    await store.append(record.id, 0, new Uint8Array([7]));
    const restored = new RecordingStorage(config);
    assert.equal((await restored.list())[0].status, "interrupted");
    assert.equal((await restored.list())[0].missing, false);
    await store.finish(record.id, true);
    const empty = await store.begin(call, notice); assert.equal((await store.finish(empty.id)).status, "interrupted");
});
test("library size limit blocks new sessions without deleting files", async () => {
    const { store } = await fixture(); const record = await store.begin(call, notice);
    await store.append(record.id, 0, new Uint8Array(2048)); await store.finish(record.id);
    await store.setPreferences({ ...structuredClone(defaults), sizeLimitMb: 0.001 });
    await assert.rejects(store.preflight(), /limit/);
    assert.equal((await store.list()).length, 1);
});
test("title edits preserve labels; export cannot overwrite; remove clears only registered files", async () => {
    const { store, base, folder } = await fixture(); const record = await store.begin(call, notice);
    await store.append(record.id, 0, new Uint8Array([8])); await store.finish(record.id);
    await store.renameTitle(record.id, "My notes");
    assert.equal((await store.list())[0].filename, record.filename); assert.equal((await store.list())[0].title, "My notes");
    const exported = join(base, "export.webm"); await store.exportTo(record.id, exported);
    await assert.rejects(store.exportTo(record.id, exported));
    await store.remove(record.id, true); assert.equal((await store.list()).length, 0);
    assert.deepEqual(await readdir(folder), []); assert.deepEqual([...await readFile(exported)], [8]);
});
test("missing folder has actionable error and corrupt libraries are preserved", async () => {
    const base = await mkdtemp(join(tmpdir(), "call-recorder-corrupt-"));
    await assert.rejects(new RecordingStorage(join(base, "empty")).preflight(), /Choose a recording folder/);
    await writeFile(join(base, "library.json"), "broken");
    await assert.rejects(new RecordingStorage(base).status());
    assert.equal(await readFile(join(base, "library.json"), "utf8"), "broken");
});
test("locating an externally moved recording grants only that file and preserves original labels", async () => {
    const { store, base, folder } = await fixture(); const record = await store.begin(call, notice);
    await store.append(record.id, 0, new Uint8Array([4])); await store.finish(record.id);
    const moved = join(base, "moved.webm"); await rename(join(folder, record.filename), moved);
    assert.equal((await store.list())[0].missing, true);
    await store.locate(record.id, moved);
    assert.equal((await store.list())[0].missing, false); assert.equal((await store.list())[0].filename, record.filename);
    assert.deepEqual([...await store.read(record.id)], [4]);
    await writeFile(join(base, "moved.json"), "unrelated sidecar");
    await store.remove(record.id, true);
    assert.equal(await readFile(join(base, "moved.json"), "utf8"), "unrelated sidecar");
});
