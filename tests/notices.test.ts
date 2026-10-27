import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NoticeReceiver, type NoticePayload } from "../plugin/notices";
import { noticeText, recordingStartLabel } from "../plugin/model";

const channel = "12345678901234567"; const recorder = "34567890123456789"; const bot = "45678901234567890";
function payload(now: number): NoticePayload { return { v: 1, sessionId: randomUUID(), recorderId: recorder, channelId: channel, event: "started", sequence: 1, issuedAt: now, expiresAt: now + 90000 }; }
test("only a configured bot in the current call with a present recorder creates trusted state", () => {
    const receiver = new NoticeReceiver(); const now = Date.now(); const p = payload(now);
    assert.equal(receiver.accept("56789012345678901", bot, channel, [recorder], p, "text", now), null);
    assert.equal(receiver.accept(bot, bot, "wrong", [recorder], p, "text", now), null);
    assert.equal(receiver.accept(bot, bot, channel, [], p, "text", now), null);
    assert.ok(receiver.accept(bot, bot, channel, [recorder], p, "text", now));
    assert.equal(receiver.statuses(channel, now)[0].state, "recording");
});
test("deduplicates and rejects stale edits and expired or oversized leases", () => {
    const receiver = new NoticeReceiver(); const now = Date.now(); const p = payload(now);
    assert.ok(receiver.accept(bot, bot, channel, [recorder], p, "text", now));
    assert.equal(receiver.accept(bot, bot, channel, [recorder], p, "replay", now), null);
    assert.equal(receiver.accept(bot, bot, channel, [recorder], { ...p, sequence: 2, expiresAt: now - 1 }, "old", now), null);
    assert.equal(receiver.accept(bot, bot, channel, [recorder], { ...p, sequence: 2, expiresAt: now + 500000 }, "bad", now), null);
    assert.equal(receiver.statuses(channel, now + 100000)[0].state, "unknown");
    assert.ok(receiver.accept(bot, bot, channel, [recorder], { ...p, sequence: 2, event: "stopped" }, "stopped", now));
    assert.equal(receiver.statuses(channel, now)[0].state, "stopped");
});
test("notice templates remain plain text and mentions are neutralized", () => {
    const text = noticeText("{recorder} in {call} @everyone {duration}", { id: channel, kind: "dm", name: "@name", recorderId: recorder, recorderName: "Sam", participants: [] }, 3200);
    assert.equal(text, "Sam in @\u200bname @\u200beveryone 3s");
    assert.throws(() => noticeText(" ", {} as any), /1 to 1500/);
});
test("library start label keeps its original timezone after travel or settings changes", () => {
    assert.equal(recordingStartLabel({ startedAt: "2026-10-26T19:30:05.000Z", utcOffsetMinutes: -240 }), "2026-10-26 15:30:05 UTC-04:00");
    assert.equal(recordingStartLabel({ startedAt: "2026-10-26T19:30:05.000Z", utcOffsetMinutes: 330 }), "2026-10-27 01:00:05 UTC+05:30");
});
