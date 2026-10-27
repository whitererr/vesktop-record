# Optional notice companion

Recording works without a bot. Use manual notices or explicitly turn outgoing notices off. The companion handles server voice-channel chat notices and compatible recipient plugin indicators. It never receives audio.

## Configure

Create a Discord application bot and invite it only to the servers you need. Use a bot token, not a personal user token. The service uses Guilds and GuildVoiceStates gateway intents. It needs View Channel, Send Messages, Embed Links and Read Message History in the selected voice-channel chats. It does not need Administrator, voice Connect/Speak, or Message Content intent.

Copy `companion/bot.example.json` outside the source checkout. Replace the recorder's user ID and the approved voice-channel IDs. Choose an absolute private path for the pairing file. The default loopback port is 32189.

Set `DISCORD_BOT_TOKEN` securely in the companion process environment and run:

```sh
cd /path/to/vesktop-record
npm ci
npm run bot -- --config /absolute/private/path/bot.local.json
```

Do not put the bot token in a config file committed to Git or in plugin settings. On Linux, keep config/pairing files in a user-private directory. The service writes the pairing secret with mode 0600. Windows ACLs need separate verification before Windows support is claimed.

In CallRecorder settings, choose Pair local companion and select that pairing file. Save settings after pairing. Set the notice mode to Companion bot. Pairing also fills the trusted bot ID, which recipients can configure independently. Each service restart rotates the local secret, so pair again after a restart.

## Runtime

The server binds only to `127.0.0.1`. Native code sends authenticated, size-limited requests to that fixed loopback host. There is no web/CORS endpoint and no arbitrary message-send API. Every notice must match the configured recorder and approved channel, and the bot verifies that recorder's current guild voice state before posting.

Event requests use idempotency keys. The client retries temporary delivery failures with backoff. The service edits a readable status message with a versioned embed payload; late arrivals also receive a separate readable notice. Mentions are disabled. Active sessions send local heartbeats, and the bot refreshes their status leases. If the recorder, plugin, bot or network disappears, recipients eventually show Recording status unknown rather than a fabricated stop.

Enable Receive verified server recording popups on recipient installations and set the exact bot ID. The receiver rejects wrong-author, wrong-channel, absent-recorder, expired and replayed events. Updates use Discord's message events and currently cached messages. Reading older status after a completely new recipient startup is not yet implemented. Popups use Vencord's notification preferences and add no synthesized sound.

Stop the service with Ctrl+C. It has no hidden autostart or audio capture. Server message and popup behavior still needs a live test with two accounts. Private-call popups and automatic DMs are outside this release.
