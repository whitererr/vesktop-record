# Vesktop call recorder MVP

Build-ready product and engineering specification. Prepared October 26, 2026.

This deliverable is a specification, not an implemented or tested plugin. The proposed audio integration must pass the feasibility checks below before the complete product is built.

## 1. Product goal

Create a private Vencord userplugin for Vesktop that records the call the user is currently attending. Support a record button, optional automatic recording, local playback, and configurable participant notices. Let the user select a persistent recording folder and automatically label saved recordings by start date, start time, and call location.

Use a neutral working identifier such as `CallRecorder`. Branding is outside this specification.

Prioritize Linux desktop, including Wayland. Validate the user's actual audio setup during development. Windows and macOS are subsequent compatibility targets, not implied support.

## 2. Platform constraints

- Vesktop includes Vencord. Implement this as a Vencord userplugin, not as a separate imaginary Vesktop plugin API. Custom plugins require building Vencord from source. [1][2]
- Install the custom build through Vesktop's developer setting for Vencord Location, then restart Vesktop. [3]
- A plugin on one computer cannot inject a popup into another person's client. Recipient popups require that person to install this plugin and enable its notice receiver. This is an architectural limitation, not a confirmed built-in Vesktop capability.
- Ordinary Discord users can receive a normal chat message. Their client and notification settings determine whether a toast, sound, or push notification appears. Posting a message does not prove everyone saw it.
- Discord forbids automating ordinary user accounts. Use an official bot account for automatic server messages. Do not extract a personal account token or automate private messages through the user account. Discord also prohibits client modifications, so this private plugin should not be presented as an officially approved Discord integration. [4][5]
- A notice is not proof of consent. The recorder must have whatever permission is required for the conversation. This specification makes no jurisdiction-specific legal claim.

## 3. Release scope

| Capability | MVP behavior |
| --- | --- |
| Manual recording | Record, pause, resume, stop, and save from the voice control area |
| Automatic recording | Off by default; starts in explicitly enabled calls or channels |
| Audio | One mixed audio recording; incoming call audio and optional own transmitted voice |
| Call types | Server voice channels, one-to-one calls, and group DM calls, subject to verified capture support |
| Local storage | Save all new recordings to a persistent user-selected folder; no audio upload |
| Recording labels | Automatically include start date, time with timezone, and call location in each filename and library entry |
| Notices | Editable chat notices, same-plugin popups, or outgoing notices off |
| Automatic server notices | Optional local companion bot using Discord's bot API |
| Private-call notices | Copy a notice for the user to send manually |
| Recording browser | Playback, rename, export, reveal, and delete |

Exclude video, screen capture, transcription, AI summaries, cloud backup, separate speaker tracks, hidden background services, and calls the recorder has not joined.

Voice announcements are a follow-up feature. Do not delay a working audio recorder to implement them.

## 4. Manual recording flow

1. User joins a supported call. A Record button appears next to the call controls.
2. On first use, the plugin asks the user to choose a save folder, audio sources, and a notice mode. Remember the folder for manual and automatic recordings; allow it to be changed in Settings > Storage.
3. Clicking Record opens a compact start panel with the call name, sources, destination, and notice preview. Remember preferences so later starts need fewer clicks.
4. Verify capture availability, directory permission, encoder support, and the configured notice route. Require a valid selected folder before starting; a missing or unwritable destination blocks both manual and automatic recording with a Choose folder action.
5. If the notice route requires a manual message, show Copy notice and a confirmation that the user sent it. The plugin does not send it as the user.
6. For bot notices, send a message saying recording will begin, then run a visible three-second countdown. Do not save audio before the countdown ends. A posted message still does not mean everyone read it.
7. Show a persistent red REC indicator, captured duration, and a level meter. Color must not be the only state cue.
8. Pause excludes audio from the saved recording. Resume continues the same recording when supported. Record pause boundaries in metadata.
9. Stop finalizes the file. Show Open recording and Reveal in folder after the write succeeds.

Notice-off mode skips outgoing notices and their countdown. The recorder's own recording indicator remains visible.

No call means the Record button is disabled with an explanation. Never present a running timer as evidence that audio capture works.

## 5. Automatic recording

Settings offer Manual only, Selected server channels, and Selected private conversations. Use stable channel or conversation IDs, not names, for rules. Do not provide a default rule that records every future conversation.

- Start when the recorder is connected, at least one other participant is present, and the selected rule matches.
- Show a three-second local countdown with Cancel. For enabled notices, complete the notice step first.
- If private-call notices require manual sending, automatic mode prepares the recording and waits for that action. It must not claim fully automatic notification.
- If the user manually stops, suppress another automatic start until they leave that call or explicitly start again.
- Stop when the recorder leaves, changes channel, is disconnected, or becomes the only participant. A channel change creates a new session.
- Treat a temporary connection loss as a capture interruption. Close the current file where possible. A successful rejoin can create a linked new session after the same start and notice checks.
- Opening Vesktop while already connected does not bypass the rule, countdown, or notice checks.
- Repeated voice-state events must not start duplicate recordings or duplicate notice messages.

## 6. Notice settings

Yes, outgoing notices can be disabled or edited. The default is notices enabled. Separate controls let the user disable one delivery method without disabling the others.

| Setting | Default | Behavior |
| --- | --- | --- |
| Outgoing notices | On | Master switch for messages and recipient popup events |
| Server chat notice | On when bot is configured | Companion bot posts in the voice-channel chat |
| Recipient plugin popup | On | Compatible recipients display a popup from a verified notice event |
| Start/stop/pause/resume notices | Enabled | Each event can be configured separately |
| Notice new participants | On | Refresh the message for late arrivals during active recording |
| Require configured notice success before capture | On | A failed required route blocks a new start or pauses an active recording |
| Message templates | Editable | Live preview and Reset to default |

Turning outgoing notices off disables outgoing recording events too. The UI says "Outgoing notices off" and does not imply other participants know. Disabling notices does not remove the recorder's own indicator or falsify previously posted messages.

Default templates:

```text
Starting: {recorder} will start recording audio in {call} in 3 seconds.
Started: {recorder} is recording audio in {call}.
Paused: {recorder} paused audio recording.
Resumed: {recorder} resumed audio recording.
Stopped: {recorder} stopped audio recording.
New participant: Audio recording by {recorder} is active in {call}.
```

Allow `{recorder}`, `{call}`, `{time}`, and `{duration}`. Treat templates as plain text, limit length, disable mentions, and reject executable content. When a delivery method is enabled, an empty template is an input error; turning that method off is an explicit action.

For a late arrival with required notices, pause saved capture, deliver the updated notice, wait the countdown, then resume. Debounce arrivals within a short interval. If notice delivery fails, remain paused and show Retry or Stop. The user may explicitly change the notice requirement or disable notices.

Changes to notice settings take effect visibly. They must not rewrite historical delivery records or imply a paused recording is active.

## 7. Recipient popups

Implement the notice receiver as part of the same plugin so a recipient can enable popups without enabling recording.

For server calls, the bot posts a readable notice plus a small versioned payload in an embed. Include the session ID, recorder ID, channel ID, event type, event sequence, issue time, and lease expiry. Never include audio, local file paths, or bot credentials.

The receiver must:

- Trust only an explicitly configured bot ID. A matching phrase or bot display name is insufficient.
- Verify that the message belongs to the recipient's current call channel and that the claimed recorder is currently a participant.
- Deduplicate by session ID and increasing event sequence. Reject expired events and edits that replay older state.
- Show the recorder's identity, recording state, and the text notice.
- Keep a dismissible in-call indicator while the recording state is current.
- Allow the recipient to mute popup sounds and adjust local popup preferences.
- Never auto-start a recording, accept consent, or execute actions from a received event.

A reconnecting recipient can inspect the latest verified status message. During active sessions, the bot refreshes that message's lease at a rate compatible with Discord's limits. If the lease expires, display "Recording status unknown" rather than "Recording stopped". A bot connection failure must not create false assurance.

Recipient popups in private calls are outside the initial release. A private call must not be advertised as supporting them merely because both people use Vesktop.

## 8. Chat delivery and companion bot

The optional companion is a small local Node.js service. It posts notices only; it does not receive, record, transcribe, or upload call audio.

- Use a separate Discord bot token, stored outside synced plugin settings with restrictive local permissions. Support an environment variable for development.
- Invite the bot only to selected servers. Request the permissions and gateway intents needed for its actual message and voice-state checks. Never request Administrator.
- Verify access to the chosen voice-channel chat and handle permission changes, Discord rate limits, and bot outages. [6]
- Pair the plugin and service with a random local secret. Bind the control endpoint to loopback, authenticate every request, and validate sizes and IDs. An Origin header is not authentication.
- Restrict actions to the configured recorder ID, approved guild/channel IDs, and channels where that recorder is present. Do not expose an arbitrary message-sending endpoint.
- Give each event an idempotency key. Retry with backoff without posting duplicate messages.
- Keep a readable status message with updates. Post a separate late-arrival notice only when needed. Do not ping everyone or mass-DM participants.

For DM and group-DM calls, Copy notice is the MVP route. Bot server access must not be treated as permission or access to existing private conversations.

The UI distinguishes "Chat notice posted", "Plugin notice event posted", "Manual notice acknowledged", "Delivery failed", and "Notices off". None means "Everyone notified" or "Everyone consented".

## 9. Screens and controls

### Voice control area

- Idle: Record.
- Preparing: Starting in 3 seconds, Cancel.
- Recording: REC, captured duration, level meter, Pause, Stop.
- Paused: Paused, Resume, Stop.
- Saving: Saving, with disabled duplicate actions.
- Error: Capture or save error with a concrete recovery action.

Use tooltips, accessible names, and keyboard navigation. Include a menu entry if the compact control area cannot fit every action. In-app shortcuts are optional; do not promise global shortcuts without platform verification.

### Settings

Group controls into Recording, Automatic rules, Notices, Storage, and Diagnostics. Every rule shows the affected call/channel and its notice mode. Show an error beside an unavailable feature instead of silently falling back.

Storage shows the selected recording folder, Choose folder / Change folder, Reveal folder, folder access status, and a filename preview. Use a native directory chooser and persist the approved destination on this computer. Changing the folder applies to the next session, including automatic recordings. An active session keeps its original destination, and existing recordings remain where they are. Keep existing recordings accessible in the library while their files remain available.

### Recordings

List start date, start time with timezone, editable title, call location, captured duration, file size, and status. Populate the initial title from the date, time, and call location used in the filename. Keep the original start timestamp and call location visible after a user renames the title. Include Play/pause, seek, Rename, Export, Reveal, and Delete. Confirm permanent deletion. If a file was moved externally, show Locate file or Remove entry.

### Diagnostics

Show pinned Vesktop/Vencord versions, call-state integration status, source availability, selected encoder, folder access, and bot connectivity. Provide a short test recording and playback. Diagnostic export is user initiated and excludes tokens, audio, and message content by default.

## 10. Audio capture design and feasibility gate

First prove capture on a pinned Vesktop/Vencord version using two test accounts and known audio. The documentation reviewed establishes plugin structure and recording APIs; it does not establish a supported Discord call-audio capture API.

Investigate decoded incoming audio streams already delivered to the local client and the local outbound audio path. Isolate Discord integration in an adapter because internal modules can change.

Required behavior:

1. Mix incoming participant streams into a stable Web Audio destination.
2. Keep the destination's output track set stable as people join or leave. Changing tracks directly on the MediaRecorder input can end recording. [7]
3. Add the recorder's own outbound voice only if the adapter can verify the relationship to mute, push-to-talk, and server mute state. Never silently substitute an always-open raw microphone.
4. Respect local mute and deafen behavior. Document whether incoming volume adjustments affect recorded levels. The MVP should record the incoming audio the user can hear and exclude locally muted participants.
5. Do not capture games, music players, or the whole desktop as an undisclosed fallback. If an operating-system capture backend is later added, make its scope explicit.
6. Do not route the recording mix back to speakers or the call. Avoid echo, doubled local audio, and feedback.
7. Test the current call encryption configuration. Capture only audio the local client has legitimately decoded; do not bypass encryption or attempt to capture unjoined calls.

Use MediaRecorder with an actually supported audio MIME type. Prefer WebM/Opus if the runtime supports it. Show the actual format, not an invented MP3 extension. A target of 96 kb/s is about 43 MB per hour before overhead; actual bitrate can vary.

If the remote stream or required mic integration cannot be verified, report the blocker. A remote-only mode is acceptable only when explicitly selected and labeled. A silent file or microphone-only recording does not pass the call-recorder gate.

## 11. Saving and file integrity

Stream encoder output to disk instead of retaining the whole call in memory. Start with approximately one-second output chunks and a bounded write queue. Stop with an error if persistent backpressure risks exhausting memory.

Use a native folder chooser to grant the recording destination. Save all new recordings and their sidecars under the selected folder. Persist the folder approval or platform access grant as needed across restarts, and revalidate write access before each session. Do not silently fall back to another directory when the folder is missing, disconnected, full, or no longer writable. Vencord's native-code guidance discourages arbitrary filesystem APIs. If native writing is needed for long recordings, expose only narrowly scoped operations against the user-approved root. [8]

Automatically generate the filename when saved audio capture begins, after any countdown. Use the local start date and 24-hour time, include its UTC offset, and snapshot the call location at that moment. Use this pattern, with the actual supported container extension:

```text
YYYY-MM-DD_HH-mm-ss±HHMM__<call-location>__<short-session-id>.<extension>
2026-10-26_15-30-05-0400__My-Server__General__a1b2c3d4.webm
2026-10-26_15-30-05-0400__DM__Alex__e5f6a7b8.webm
2026-10-26_15-30-05-0400__Group-DM__Study-Group__c9d0e1f2.webm
```

- For a server call, the location contains the server name and voice-channel name. For a private call, use `DM` and the other participant's display name. For a group call, use `Group-DM` and the conversation title, or its stable conversation ID if unnamed. Missing names fall back to the corresponding stable IDs. Location means the call's identity, not a geographic location.
- Sanitize every name component for the target filesystem. Remove path separators and control characters, handle reserved names and trailing dots or spaces, and cap the full filename length. Keep readable Unicode when supported. Names and titles must never become path instructions.
- Include a session suffix and use exclusive creation to avoid overwriting recordings that start in the same second or have identical sanitized labels. Retry a collision with a fresh suffix.
- Keep the timestamp, offset, destination, and location label stable for the session, including across pauses, timezone changes, and channel renames. Moving to a different call creates a new session and label.
- Use the same filename stem for the audio and JSON sidecar. During capture, append `.partial` to the audio filename, for example `2026-10-26_15-30-05-0400__My-Server__General__a1b2c3d4.webm.partial`. Remove only that suffix after successful finalization.
- Keep the destination path in local storage configuration. Do not include local paths in chat notices or recipient popup events.

- Create a unique session file with exclusive creation and a `.partial` suffix.
- Append ordered chunks through a serialized writer with acknowledgement and bounded chunk sizes.
- On normal stop, wait for the final `dataavailable` event, flush and close the file, then mark it complete and rename it with the actual container extension.
- Sanitize filenames; reject traversal and symlink escapes. The renderer should pass a session ID, not an arbitrary output path, on append/finish calls.
- On disk-full, write failure, or permission loss, stop capture and retain recoverable data. Never show Saved before finalization succeeds.
- Detect incomplete sessions on restart and offer recovery or deletion. Do not guarantee recovery after an abrupt crash. Individual MediaRecorder chunks are not necessarily independently playable. [7]
- Never stop Discord-owned tracks during cleanup. Disconnect recording graph nodes and stop only resources created and owned by the plugin.

Store a small JSON sidecar with a random session ID, call ID, call type, the call-location names used for the label, UTC start/end timestamps, the start-time UTC offset, generated filename, captured duration, format, pause/interruption events, notice configuration, delivery outcomes, and completion status. Store no unrelated conversation history. Chat notice text already posted to Discord remains there even if the local recording is deleted.

Keep files until the user deletes them. Offer storage usage and an optional size limit that stops new recordings. Automatic deletion and cloud syncing are outside this release.

## 12. State and error handling

Use one session controller with explicit states: idle, preparing, countdown, recording, paused, stopping, saved, interrupted, and error. Serialize start/stop transitions. Every asynchronous operation carries a session ID so stale events cannot affect a later call.

Separate capture state from notice delivery state. A bot message is not proof of capture, and capture success is not proof of notice delivery.

- Plugin disabled or Vesktop closes normally: finalize and clean up.
- Another participant joins: add their source and apply the late-arrival notice policy.
- All remote participants leave: stop and save.
- Capture track ends unexpectedly: show an interruption and attempt orderly finalization.
- Notice fails with notice requirement enabled: block start or pause capture.
- Notice fails with notice requirement disabled: show a persistent local failure indicator and retain the actual delivery result.
- App crashes: do not emit a fabricated stopped event on restart. Retain interrupted metadata and let remote status become unknown.

## 13. Voice announcements and DMs

Defer these until the recorder and chat path pass acceptance testing.

A later server announcement can use a bot that joins voice and plays a short clip such as "This call is being recorded." It needs separate voice permissions and a tested voice implementation compatible with Discord's current encryption requirements.

Playing a browser speech-synthesis voice locally does not announce anything to other participants. Discord's TTS message option must not be described as guaranteed in-call audio.

Automatic DMs are a poor primary notice route because of privacy settings, delivery failures, and repetition. If added later, use the bot API, explicit recipient opt-in, and per-recipient delivery results. Do not auto-DM through the recorder's normal account.

## 14. Build order and required deliverables

1. Pin source revisions and prove capture, file writing, playback, mute/PTT behavior, and cleanup. Record actual supported combinations.
2. Build the manual recorder and persistent call controls.
3. Add automatic rules and interruption handling.
4. Add editable notices, the optional companion bot, and receiver popups.
5. Add the recording browser, recovery workflow, and installation documentation.

Suggested source modules are the plugin entry point, settings, session controller, Discord audio adapter, audio mixer/encoder, scoped native writer, recording browser, notice receiver, and companion bot. Use TypeScript and the existing Vencord tooling. Follow current source examples instead of guessing Discord module names.

Deliver source, reproducible build instructions, custom-build installation and rollback instructions, the optional bot setup guide, a supported-version matrix, and the acceptance results. Clearly label mocked adapters and unfinished platform support. Do not claim upstream Vencord acceptance or publish/install anything on the user's behalf as part of writing this specification.

## 15. Acceptance criteria

The MVP is complete only when these checks pass on the declared supported environment:

1. A real two-person call produces an audible recording containing both selected sources with no feedback or doubled voice.
2. Mute, deafen, local participant mute, server mute, and push-to-talk follow the documented capture behavior. An excluded mic is never recorded.
3. Manual start, pause, resume, stop, rapid repeated clicks, and leaving the call produce valid state and playable saved files.
4. A 60-minute recording remains playable and does not retain the whole recording in memory.
5. Joining and leaving participants does not invalidate the encoder's output track set or crash the session.
6. Only explicitly enabled automatic rules start recording. Manual Stop suppresses restart for the current call.
7. A server chat notice is actually posted by the configured bot. A second client with the plugin displays the corresponding popup. An ordinary Discord client sees the readable chat notice.
8. Edited templates appear correctly. Disabling outgoing notices sends no notice messages or status events and leaves the recorder's own indicator visible.
9. Missing bot permissions, disconnected bot, rate limits, and new participants follow the chosen notice requirement without falsely reporting delivery.
10. Forged messages, stale events, duplicate events, and mismatched channel IDs cannot create a trusted recording indicator.
11. Private-call notice mode requires manual sending or explicitly disabled notices. It never pretends a server bot notified the private call.
12. Disk-full, rejected folder permission, application exit, and forced crash preserve truthful file status and offer appropriate recovery.
13. Disabling the plugin releases owned resources without ending the Discord call, opening an unexpected microphone, or leaving capture running.
14. The bot receives no audio or recording file. Logs and exported diagnostics contain no credentials.
15. The user can select and later change the recording folder. The selection persists across restarts and applies to manual and automatic recordings. Changing it during recording leaves that session and existing files in their original locations. An unavailable folder prevents new capture and offers Choose folder without silently changing the destination.
16. Finalized audio files and matching sidecars are saved in the selected folder with the start date, 24-hour start time, UTC offset, and correct call location in their filenames. Verify server voice, DM, and group-DM labels, unnamed conversations, Unicode and filesystem-unsafe names, same-second collisions, and a timezone change during recording. No existing file is overwritten, and the library shows the original start time and call location after a title edit.

## 16. Sources

Primary sources checked October 26, 2026. Product choices and proposed architecture above are recommendations, not claims that an existing supported call-recording API provides them.

1. Vesktop repository: https://github.com/Vencord/Vesktop
2. Vencord custom plugin installation: https://docs.vencord.dev/installing/custom-plugins/
3. Vencord source builds and Vesktop installation: https://docs.vencord.dev/installing/
4. Discord automated user accounts policy: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
5. Discord platform manipulation policy: https://discord.com/safety/platform-manipulation-policy-explainer
6. Discord message API: https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx
7. W3C MediaStream Recording working draft: https://www.w3.org/TR/mediastream-recording/
8. Vencord native NodeJS code guidance: https://docs.vencord.dev/plugins/native/
