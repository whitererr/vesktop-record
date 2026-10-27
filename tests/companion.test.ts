import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCompanion } from "../companion/server";

test("companion authenticates every request, restricts scope, verifies presence and deduplicates", async () => {
    const posts: unknown[] = []; const verifications: unknown[] = [];
    const config = { recorderId: "34567890123456789", channelIds: ["12345678901234567"] };
    const service = createCompanion(config, "local-secret", {
        async verify(channel, user) { verifications.push([channel, user]); },
        async post(channel, text, payload) { posts.push({ channel, text, payload }); return "98765432109876543"; }
    });
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const address = service.server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const event = { sessionId: randomUUID(), channelId: config.channelIds[0], recorderId: config.recorderId, event: "starting", text: "Starting recording", key: randomUUID() };
    const post = (body: unknown, headers: Record<string, string> = {}, path = "/event") => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer local-secret", ...headers }, body: JSON.stringify(body) });
    try {
        assert.equal((await post(event, { Authorization: "Bearer wrong" })).status, 401);
        assert.equal((await post(event, { Origin: "https://discord.com" })).status, 404);
        assert.equal((await post({ ...event, channelId: "45678901234567890" })).status, 400);
        assert.equal((await post({ ...event, recorderId: "45678901234567890" })).status, 400);
        const first = await post(event); assert.equal(first.status, 200);
        assert.deepEqual(await (await post(event)).json(), await first.json());
        assert.equal(posts.length, 1); assert.equal(verifications.length, 1);
        assert.equal((await post(event, {}, "/heartbeat")).status, 200);
        assert.equal((await post({ ...event, sessionId: randomUUID() }, {}, "/heartbeat")).status, 400);
        assert.equal((await post({ ...event, text: "a".repeat(9000) })).status, 413);
        assert.equal((await post({ ...event, text: "different" })).status, 503);
    } finally { await service.close(); }
});
