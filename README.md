# CallRecorder for Vesktop

An experimental Vencord userplugin based on [the MVP](docs/MVP.md). It saves incoming call audio locally, with a persistent folder picker and filenames containing the date, time, UTC offset, and call location.

This is a buildable implementation, **not a release-qualified call recorder**. The Discord output adapter has not been tested in a real Vesktop call. Recording is blocked if the adapter cannot identify incoming voice outputs belonging to current participants. Own transmitted voice is unavailable. Select incoming audio only explicitly to use this version.

## Build

Use Node.js 22 or later and Git. The build script downloads the pinned Vencord source and uses its pinned pnpm 11.9.0 and frozen lockfile. It does not inject into any installed client.

```sh
cd /workspace/vesktop-record
npm ci
npm run prepare:vencord
npm run typecheck
npm test
npm run build
```

The custom Vencord build is in `dist/`. Source is in `plugin/`. `.cache/vencord/src/userplugins/callRecorder` is a generated copy, refreshed by the build scripts. Edit `plugin/`, then rerun the build. `npm run watch` watches that generated copy, so copy source changes into it or restart watch after edits. For a normal development cycle, rebuilding is simpler.

For the browser audio and controls check, install Chromium and FFmpeg, then run:

```sh
npm run test:audio
```

The test defaults to `/usr/bin/chromium`; set `CHROMIUM_PATH` if needed. It uses generated audio and test doubles for Discord stores and the native dialog/IPC bridge. The real session controller, Web Audio mixer, MediaRecorder, recording UI and filesystem storage run together. Results and a screenshot are saved under `.cache/audio-smoke/`. This does not exercise the live Discord patch or Electron dialogs.

## Install on your computer

1. Build locally, or extract the provided custom-build archive on your desktop computer. Keep the whole `dist` folder together.
2. In Vesktop settings, open Developer Options and set **Vencord Location** to that `dist` folder. It contains `vencordDesktopMain.js`, `vencordDesktopPreload.js`, `vencordDesktopRenderer.js`, and `vencordDesktopRenderer.css`.
3. Fully quit and restart Vesktop. Enable **CallRecorder** in Vencord's Plugins settings. Restart again if requested so its patches load.
4. Open CallRecorder's settings or its floating Settings button. Choose a recording folder, explicitly select incoming audio only, configure notices, and save the settings. Manual notices are the default. Automatic recording is off by default.
5. Join a test call with another account and have them speak. Open Diagnostics and check for recognized current-call sources. If none appear, rejoin once. If they remain unavailable, stop here and follow [the integration gate](docs/ACCEPTANCE.md). Do not assume a build proves capture support.
6. Start a short recording, verify the level meter, stop, and play the saved file. Check mute and deafen before relying on recordings.

The call-header controls depend on a Discord patch. The floating controls and plugin settings provide another route if that header changes. A successful start shows REC, captured duration, a meter, Pause and Stop. Pause excludes audio and elapsed duration. Stopping waits for the encoder's final chunk and acknowledged writes before showing Saved.

To roll back, stop any recording, disable CallRecorder, reset Vesktop's Vencord Location to its default, and fully restart Vesktop. Existing audio remains in the selected folders. Native configuration and the library index are in `CallRecorder/` under Electron's `app.getPath("userData")`.

## Files and recording library

Example names:

```text
2026-10-26_15-30-05-0400__My-Server__General__a1b2c3d4.webm
2026-10-26_15-30-05-0400__DM__Alex__e5f6a7b8.webm
2026-10-26_15-30-05-0400__Group-DM__Study-Group__c9d0e1f2.webm
```

The timezone and location are captured at recording start. Names are sanitized and bounded, and exclusive creation prevents overwrites. Audio is streamed in roughly one-second chunks through bounded queues. A `.partial` suffix remains until successful finalization. A matching `.json` sidecar holds session metadata and actual notice outcomes.

Storage settings remember the approved folder across restarts. Changing it affects the next recording, including automatic recordings. An active recording and existing files stay in their original folders. A missing or unwritable folder blocks capture instead of changing the destination silently.

The library supports playback and seeking, title edits, export, reveal, external playback, and confirmed permanent deletion. A title edit preserves the original filename and call label. Internal playback has a 128 MiB limit; use Open externally for larger recordings. Interrupted files remain available for export or deletion; playback or recovery is not guaranteed. Missing completed files can be located with a native picker or removed from the index. Diagnostics can be exported without audio, tokens, message text, paths or participant identities.

## Automatic recording and notices

Add selected channel or conversation IDs in settings, or use Add current call. A matching rule starts only when another participant is present and preflight succeeds. Automatic starts show a cancellable countdown. Manual Stop suppresses restart until you leave that call. Leaving, changing calls, or becoming the only participant finalizes the current session.

Notice modes are manual copy/acknowledgement, a local companion bot for server calls, or outgoing notices off. Manual mode waits for the user to send the notice and confirm it. Private calls use manual notices or notices off. The plugin never sends chat messages as the user's account.

The optional companion is documented in [docs/COMPANION.md](docs/COMPANION.md). It sends notices only and has no audio endpoint. Recipient popups require this plugin, an explicitly trusted bot ID, and a current-call membership match. Popup state expires to unknown when its lease ends. A chat post or acknowledgement does not establish receipt or consent.

## Compatibility and remaining checks

| Component | Status |
| --- | --- |
| Vencord `443688b5366a4d43e9868519f48a4544cd7520d4`, version 1.15.13 | Full custom build and TypeScript check pass |
| Vesktop 1.6.8, reference source `3cb2a7bc1306923b60157231430c5b4e78e531da` | Installation interface inspected; desktop runtime not exercised |
| Chromium 154 on Linux | Generated-audio recording, pause, deafen, playback and seek pass |
| Native storage | Folder persistence, streaming, collision refusal, symlink checks and failure behavior tested |
| Real server, DM and group-DM audio | Not validated; internal audio hook and user identity mapping may require adaptation |
| Own transmitted voice, microphone mute, server mute and PTT | Unavailable; no raw microphone fallback |
| Live Discord bot and second-client popups | Implemented; tested with a fake transport, not live credentials |
| 60-minute recordings, Wayland desktop, Windows and macOS | Not tested |

See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for the release gate and remaining MVP work. This is a private custom client modification, not an official Discord integration. Source and bundled Vencord code are GPL-3.0-or-later.
