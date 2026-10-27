import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createCompanion, type BotConfig } from "./server";
import { NOTICE_PREFIX } from "../plugin/notices";

const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) throw new Error("Usage: npm run bot -- --config /absolute/path/bot.local.json");
const config: BotConfig & { port?: number; pairingFile: string } = JSON.parse(await readFile(resolve(process.argv[configIndex + 1]), "utf8"));
if (!/^\d{5,22}$/.test(config.recorderId) || !config.channelIds?.length || config.channelIds.some(id => !/^\d{5,22}$/.test(id))
    || !config.pairingFile || !Number.isInteger(config.port ?? 32189) || (config.port ?? 32189) < 1024 || (config.port ?? 32189) > 65535) throw new Error("Invalid bot configuration.");
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("Set DISCORD_BOT_TOKEN in the companion process environment.");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
await client.login(token);
if (!client.isReady()) await new Promise<void>(resolve => client.once("clientReady", () => resolve()));
const secret = randomBytes(32).toString("hex");
const service = createCompanion(config, secret, {
    async verify(channelId, recorderId) {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isVoiceBased() || channel.isDMBased() || !channel.isSendable()) throw new Error("Configured channel is not a server voice-channel chat.");
        const voice = channel.guild.voiceStates.cache.get(recorderId);
        if (voice?.channelId !== channelId) throw new Error("Recorder is not in that channel.");
        const permissions = channel.permissionsFor(client.user!);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new Error("Bot lacks channel-chat permissions.");
    },
    async post(channelId, text, payload, existingMessageId) {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error("Channel is not sendable.");
        const body = { content: text, allowedMentions: { parse: [] as never[] }, embeds: [{
            title: "Call recording status", description: "This reports recording state, not consent or confirmed receipt.",
            footer: { text: NOTICE_PREFIX + JSON.stringify(payload) }
        }] };
        const message = existingMessageId ? await channel.messages.edit(existingMessageId, body) : await channel.send(body);
        return message.id;
    }
});
await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(config.port ?? 32189, "127.0.0.1", () => resolve());
});
const pairingPath = resolve(config.pairingFile);
await mkdir(dirname(pairingPath), { recursive: true, mode: 0o700 });
// A restart rotates the local secret. Pair again after restarting the companion.
await writeFile(pairingPath, JSON.stringify({ version: 1, port: config.port ?? 32189, secret, botId: client.user!.id }), { mode: 0o600 });
console.log(`Notice companion listening on loopback port ${config.port ?? 32189}. Select the pairing file in CallRecorder settings. No audio is received by this service.`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void service.close().finally(() => { client.destroy(); process.exit(0); }); });
