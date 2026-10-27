# Validation and release gate

The specification in `MVP.md` remains the target. This implementation has not completed its real-call feasibility gate, so it must remain experimental.

## Checks run in this cloud environment

- `npm test` exercises native storage, the session controller, audio-source filtering, template handling, the notice receiver and authenticated companion HTTP requests with an injected fake Discord transport.
- `npm run typecheck` checks both the standalone modules and the plugin inside the pinned Vencord source tree.
- `npm run build` creates Vencord's desktop and Vesktop bundles, including the renderer and native plugin helpers.
- `npm run test:audio` drives the actual settings and recording UI in Linux Chromium using generated incoming audio, simulated Discord stores and a test native bridge backed by the real storage implementation. It tests folder selection, explicit incoming-only selection, notices off, record/pause/resume, deafen silence, stop, playback and seeking. FFmpeg independently decodes the saved Opus file and checks audible and silent intervals. The source track remains live after cleanup.

The browser test does not exercise Electron IPC serialization, a native directory dialog, the injected Discord patch, call encryption, or a bot connected to Discord. The generated audio is a test fixture, not evidence of a working real-call adapter.

## Desktop feasibility check

Use two accounts you control and known audio. Record exact Vesktop, Vencord and Discord build versions alongside the results. Start with the pinned versions in README.md.

1. Load the custom build and enable CallRecorder. Join a server voice call from both accounts. In Diagnostics, confirm the output hook is firing and recognized current-call sources are nonzero. The current hook uses the same `streamSourceNode` output-class anchor as upstream VolumeBooster. It requires an output's `userId` or `id` to match a current participant and excludes video/screen outputs. These assumptions are unverified against live Discord. If they fail, update only the audio adapter after inspecting the running client. Do not weaken identity/scope checks just to get a file.
2. Select incoming audio only. Record the second account speaking, stop and play back. Check that no desktop sounds or own microphone were captured. Compare participant volume, local mute and deafen to the audible result. Change calls and verify that old source objects are not reused.
3. Repeat in a DM and a group-DM call. Verify names, missing-name fallbacks and stable IDs. Test joining/leaving speakers and an unexpected source-track end.
4. Own transmitted voice remains disabled. A future adapter must tap the actual outbound path and prove behavior under mute, server mute and PTT before that source can be offered. Opening an always-on raw microphone does not pass.
5. Test automatic rules, manual Stop suppression, duplicate events and late arrivals during countdown. Required notice failure must block a start or leave an active session paused. Test rapid stop/resume and leaving while the manual notice prompt is open.
6. Test a real companion bot in an approved server and a second client with the plugin. Verify readable notices on an ordinary client, popup authenticity, pause/stop state changes, permissions, rate limits, reconnection and lease expiry. Never infer delivery to everyone from a successful bot response.
7. Record for 60 minutes. Check process memory, file growth and final playback. Test disk-full, revoked folder permissions, detached drives and forced app termination. After a crash, interrupted metadata and retained partial data are expected, not guaranteed recovery.
8. Exercise a normal Vesktop exit and plugin disable. A native `before-quit` guard asks the renderer to stop and flush the encoder before quitting, with a 15-second timeout and interrupted-file fallback. This handshake uses Electron's real WebContents API but has not been exercised inside Vesktop. Treat unfinished sessions as interrupted on restart, especially after forced termination.

## Remaining MVP work

- Verify or adapt the decoded incoming-audio hook against a real call. This is the primary release blocker.
- Verify Electron native helpers and directory selection in Vesktop on Linux and Wayland.
- Prove a processed outbound-voice integration before enabling own voice. No microphone permission is requested in this implementation.
- Run live bot and second-client tests. Add initial latest-status hydration for recipients who reconnect without cached message events.
- Verify native Locate file, diagnostic export and the orderly-shutdown handshake in Vesktop. Add more guided recovery if needed. Current recovery offers partial-file export/delete and does not promise repair.
- Run the long-recording and platform matrix. Windows and macOS are not supported claims.
- Replace the generated-copy watch workflow with source synchronization if continuous upstream watch development is needed.

Do not mark the MVP complete until the applicable acceptance criteria in `MVP.md` have real results. Keep failed, unrun and passed results separate.
