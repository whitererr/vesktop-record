import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputRegistry } from "../plugin/audio";

function stream(audio = true, video = false, live = true): MediaStream {
    return { getAudioTracks: () => audio ? [{ readyState: live ? "live" : "ended" }] : [], getVideoTracks: () => video ? [{}] : [] } as unknown as MediaStream;
}
test("registry excludes unknown users, recorder microphone, video and screen audio", () => {
    const registry = new OutputRegistry();
    for (const data of [
        { id: "remote", stream: stream() }, { id: "self", stream: stream() },
        { id: "unknown", stream: stream() }, { id: "screen", userId: "remote", stream: stream(), videoStreamId: "screen-share" },
        { id: "video", userId: "remote", stream: stream(true, true) }, { id: "noaudio", userId: "remote", stream: stream(false) },
        { id: "ended", userId: "remote", stream: stream(true, false, false) }
    ]) registry.observe({ ...data, _mute: false, _volume: 100 });
    assert.deepEqual(registry.current(["self", "remote"], "self").map(data => data.id), ["remote"]);
    registry.observe({ id: "remote", stream: stream(), _mute: false, _volume: 100 }, "call-a");
    assert.equal(registry.current(["self", "remote"], "self", "call-b").length, 0);
    assert.equal(registry.current(["self", "remote"], "self", "call-a").length, 1);
});
