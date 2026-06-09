# ElevenLabs Scribe v2 Realtime Dictation

A self-contained, low-latency **realtime** medical dictation web app built on a single Cloudflare Worker. This is the realtime (WebSocket) sibling of the Scribe v2 batch dictation tool: text appears live in the transcript box as you speak, and the finished text lands on the clipboard the moment you release push-to-talk.

**Key features:**

- **Push-to-talk dictation** in the app (click / F13–F14), fully compatible with an existing AutoHotkey CapsLock setup — no changes needed to a working AHK script.
- **Live transcript** streamed from ElevenLabs Scribe v2 Realtime over a secure WebSocket proxy (the API key never reaches the browser in shared mode).
- **Anti-clipping pipeline**: audio is buffered from the instant you press PTT (nothing is lost while the socket connects) and keeps streaming for a short tail after release, then the app commits and *waits for the final transcript* before closing — so the first and last words survive.
- **Loud failure notification**: dead-mic alarm while you're still dictating, connect-timeout alarm, distinct failure beeps that play even in a background tab, clipboard sentinel (`##DICTATION_FAILED##`) when nothing usable was captured, and status pills (mic / link) that show health at a glance.
- **Smart append window**: consecutive dictations within N seconds continue the same note; after the window lapses the next dictation starts fresh. A chip above the transcript shows which will happen, with a live countdown.
- **Custom keyword biasing** (up to 50 keyterms) for specialized medical vocabulary.
- **Installable web app** (PWA manifest): install from the browser menu to get a standalone window with its own icon — handy in constrained/Citrix-adjacent environments.

---

## Architecture overview

```
Browser (this page, installable PWA)
  mic → high-pass → ┬→ analyser (meter, gate UI, health watchdog)
                    ├→ ScriptProcessor → 16 kHz PCM → base64 frames ─┐
                    └→ noise gate → MediaRecorder (local playback)   │
                                                                     ▼
Cloudflare Worker  /api/transcribe  (WebSocket proxy, key injection, keyterm scrub)
                                                                     ▼
ElevenLabs  wss …/v1/speech-to-text/realtime  (scribe_v2_realtime, VAD commits)
```

Notes:

- The **noise gate only shapes the locally saved audio preview**. The realtime feed to Scribe is *not* gated — extraneous-speech rejection is done server-side via the Scribe VAD parameters (noise filter / click filter / pause limit) under **Advanced audio & noise settings**.
- One WebSocket session per dictation. Press PTT again while the previous dictation is still finalizing and the new dictation is queued and starts automatically.

## Deployment

```sh
npx wrangler deploy
```

Two modes, controlled by Worker environment variables:

| Variable | Effect |
|---|---|
| *(none)* | Each user pastes their own ElevenLabs API key into the UI. |
| `ELEVENLABS_API_KEY` **and** `APP_PASSPHRASE` | **Shared mode**: users enter only the passphrase; the Worker injects the master key server-side. |

Set secrets with `npx wrangler secret put ELEVENLABS_API_KEY` (and `APP_PASSPHRASE`).

### Install as an app (optional)

Open the deployed URL in Chrome/Edge → browser menu → **Install app** (or the install icon in the address bar). The app opens in its own standalone window, keeps mic permission, and is easier to keep running between dictations.

## Daily workflow

1. Open the app (or standalone window). The mic warms automatically if permission was previously granted — the **mic ready** pill confirms it.
2. Hold CapsLock (via AHK) or press the record button / F13. Start beep = go.
3. Speak. Text appears live in the transcript box; the **REC** and **LIVE** pills confirm both mic and pipeline are healthy.
4. Release. The app streams a short audio tail, commits, waits for the final words, then copies the full text to the clipboard. **Rising double beep = text is on the clipboard.** Switch windows and paste.
5. Dictate again within the append window to continue the same note (the combined text is recopied each time), or wait for the window to lapse / press **Start fresh** to begin a new note.

### Audio cues

| Sound | Meaning |
|---|---|
| Single mid beep | Recording started |
| Rising double beep | Success — transcript copied to clipboard |
| Long low beep | Failure — sentinel copied, or clipboard copy failed (do **not** paste) |
| Three descending low beeps | **Mic dead alarm** — recording but no audio signal (fires mid-dictation) |
| Two mid beeps | Audio is flowing but no text is coming back from the service |

Start/done beeps can be disabled with the checkbox; **failure alarms always play**, and they reuse the live audio context so they sound even when the tab is in the background.

### Status pills

- **mic ready / REC / MIC FAIL / mic off** — actual `MediaStreamTrack` health, not just permission state.
- **link idle / connecting… / LIVE / LINK FAIL** — WebSocket pipeline state.
- **gate open/closed** — local noise gate (affects only the saved audio preview).
- **append chip** (above the transcript) — whether the next dictation appends or starts fresh, with a countdown.

## Failure handling (the important part)

The biggest risk in dictation is speaking a long passage into a dead pipeline and only finding out afterwards. This app attacks that from several angles:

- **While recording**: a watchdog checks the mic track (`ended`/`muted`) and the RMS level. A flatlined mic triggers the three-beep alarm and a red status *within ~2.5 s of pressing PTT* — before the long paragraph, not after.
- **Connecting**: if the WebSocket can't open within 5 s, the dictation fails loudly (sentinel + low beep) instead of silently discarding audio. Audio spoken during connection setup is buffered and flushed once the socket opens.
- **Mid-dictation disconnect**: an unexpected close is treated as a failure — whatever partial text arrived is still copied (better than losing it), but the status turns red and the failure beep plays so you verify before pasting.
- **Clipboard**: if the copy fails (tab lost focus too early), the failure beep plays instead of the success beep, and the status says not to paste. If nothing was transcribed at all, the sentinel `##DICTATION_FAILED##` is copied so a blind paste is self-evident.
- **Reopening the app**: the audio graph is revalidated on every start, on tab restore (`pageshow`/bfcache), on visibility change, and on device changes — a stale, silently-dead mic stream is torn down and re-acquired instead of being trusted.

## Append semantics

- **Append mode on (default)**: a dictation started within the **append window** (default 45 s, configurable, 0 = always) continues the current note; the combined text is what gets copied. After the window lapses, the next dictation starts a fresh note automatically.
- **Start fresh** button: clears the current note immediately (history is untouched).
- **Append mode off**: every dictation is its own note.

History (last 100 transcripts) is stored in `localStorage`; each entry is a snapshot of what was on the clipboard at that moment.

## AutoHotkey

Any AHK setup that sends **F13 on press / F14 on release** to the browser window keeps working unchanged — in-page handling is identical to the batch app. Example (AHK v1):

```ahk
*CapsLock::
    if WinExist("ElevenLabs Scribe v2 Dictation") {
        ControlSend,, {F13}, ElevenLabs Scribe v2 Dictation
    }
    KeyWait, CapsLock
    if WinExist("ElevenLabs Scribe v2 Dictation") {
        ControlSend,, {F14}, ElevenLabs Scribe v2 Dictation
    }
return
```

Keep the dictation tab/window focused until the success beep if you rely on auto-copy (browsers block clipboard writes from unfocused pages).

## Configuration reference

| Setting | Default | Notes |
|---|---|---|
| Keyterms | — | ≤ 50 terms, ≤ 20 chars, ≤ 5 words each; adds ~20 % to cost |
| Append window | 45 s | 0 = always append while append mode is on |
| Scribe pause limit | 2.0 s | Higher = waits longer before finalizing a segment |
| Scribe noise filter | 0.55 | Higher = less sensitive to background speech |
| Scribe click filter | 150 ms | Higher = ignores brief clicks/rustles |
| Gate open/close, high-pass | 0.030 / 0.008 / 85 Hz | Local audio preview only |

All settings persist in `localStorage`. The API key/passphrase persists only when "Remember on this browser" is checked.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Mic won't engage after reopening | Should now self-heal (track revalidation on `pageshow`/visibility). If the *mic off* pill persists, click the page once (autoplay policy) or re-grant mic permission. |
| Three-beep alarm right after starting | OS muted the mic, wrong input device, or Citrix audio redirection dropped. Check the meter moves when you speak. |
| Text stops mid-dictation, red status | Network/service drop. The partial transcript was still copied — verify it before pasting. |
| Last words missing | Should be fixed by the tail + commit-wait flow. If it recurs, raise *Scribe pause limit* slightly. |
| Success beep but paste shows `##DICTATION_FAILED##` | The previous dictation failed and the sentinel was left; the beep belongs to the newer one. Use the history panel. |
| Nothing transcribes, *LINK FAIL* | Worker can't reach ElevenLabs or the API key/passphrase is wrong — the status line shows the upstream error. |
