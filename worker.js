export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      return handleTranscribe(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Shared mode is on when both the master API key and a passphrase are set
      const sharedMode = Boolean(env && env.ELEVENLABS_API_KEY && env.APP_PASSPHRASE);
      return new Response(
        INDEX_HTML.replace("__SHARED_MODE__", sharedMode ? "true" : "false"),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        }
      );
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleTranscribe(request, env) {
  // Scribe Realtime uses WebSockets. Verify handshake upgrade
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 400 });
  }

  // Create client/server pair early so we can safely report errors back to the browser UI
  const [clientWs, workerWs] = new WebSocketPair();

  // Helper to accept client socket and send a JSON error frame before closing
  const returnWsError = (errorMsg) => {
    workerWs.accept();
    workerWs.send(JSON.stringify({ message_type: "error", error: errorMsg }));
    workerWs.close(1008, "handshake_failed");
    return new Response(null, { status: 101, webSocket: clientWs });
  };

  try {
    const url = new URL(request.url);

    const clientKey  = String(url.searchParams.get("api_key") || "").trim();
    const serverKey  = (env && env.ELEVENLABS_API_KEY) || "";
    const serverPass = ((env && env.APP_PASSPHRASE) || "").trim();

    let apiKey = clientKey;
    if (!apiKey && serverKey && serverPass) {
      const given = String(url.searchParams.get("passphrase") || "").trim();
      if (!safeEqual(given, serverPass)) {
        return returnWsError("Unauthorized passphrase");
      }
      apiKey = serverKey;
    }

    if (!apiKey) {
      return returnWsError("Missing ElevenLabs API Key configuration");
    }

    const noVerbatim = url.searchParams.get("no_verbatim") !== "false";
    const includeTimestamps = url.searchParams.get("timestamps") !== "none";
    
    // Dynamic Server-side VAD variables from UI [3]
    const vadSilence = url.searchParams.get("vad_silence_threshold_secs");
    const vadThreshold = url.searchParams.get("vad_threshold");
    const minSpeech = url.searchParams.get("min_speech_duration_ms");

    // Parse and clean vocab keyterms
    let keyterms = [];
    try {
      keyterms = JSON.parse(url.searchParams.get("keyterms_json") || "[]");
    } catch {
      keyterms = [];
    }

    const seen = new Set();
    const cleanedKeyterms = (Array.isArray(keyterms) ? keyterms : [])
      .filter((t) => typeof t === "string")
      .map((t) => t.trim().replace(/[<>{}\[\]\\]/g, "").replace(/\s+/g, " "))
      .filter(Boolean)
      .filter((t) => t.length <= 20 && t.split(" ").length <= 5)
      .filter((t) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 50);

    // Construct backend connection parameters for ElevenLabs Scribe Realtime v2
    const elevenParams = new URLSearchParams();
    elevenParams.append("model_id", "scribe_v2_realtime");
    elevenParams.append("audio_format", "pcm_16000");
    elevenParams.append("language_code", "en");
    elevenParams.append("commit_strategy", "vad");
    elevenParams.append("no_verbatim", String(noVerbatim));
    elevenParams.append("include_timestamps", String(includeTimestamps));

    // Dynamic Scribe tuning parameters [3]
    if (vadSilence) elevenParams.append("vad_silence_threshold_secs", vadSilence);
    if (vadThreshold) elevenParams.append("vad_threshold", vadThreshold);
    if (minSpeech) elevenParams.append("min_speech_duration_ms", minSpeech);

    for (const term of cleanedKeyterms) {
      elevenParams.append("keyterms", term);
    }

    // Connect to ElevenLabs using secure Workers fetch
    const backendWsUrl = "https://api.elevenlabs.io/v1/speech-to-text/realtime?" + elevenParams.toString();

    const backendResponse = await fetch(backendWsUrl, {
      headers: {
        "Upgrade": "websocket",
        "xi-api-key": apiKey,
      }
    });

    if (backendResponse.status !== 101) {
      const errText = await backendResponse.text();
      return returnWsError(`ElevenLabs Connection Error (${backendResponse.status}): ${errText}`);
    }

    const backendWs = backendResponse.webSocket;
    if (!backendWs) {
      return returnWsError("Could not retrieve backend WebSocket");
    }

    backendWs.accept();
    workerWs.accept();

    // Bind events - forward messages between browser and ElevenLabs
    workerWs.addEventListener("message", (event) => {
      backendWs.send(event.data);
    });

    backendWs.addEventListener("message", (event) => {
      workerWs.send(event.data);
    });

    workerWs.addEventListener("close", () => {
      backendWs.close();
    });

    backendWs.addEventListener("close", () => {
      workerWs.close();
    });

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  } catch (err) {
    return returnWsError(`Worker initialization failed: ${err?.message || String(err)}`);
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ElevenLabs Scribe v2 Dictation</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #151922;
      --panel2: #10141b;
      --text: #eef2f6;
      --muted: #9aa4b2;
      --line: #2a3140;
      --accent: #7dd3fc;
      --danger: #f87171;
      --ok: #86efac;
      --warn: #fde68a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.35;
    }
    main { max-width: 1000px; margin: 0 auto; padding: 22px; }
    h1 { font-size: 22px; margin: 0 0 14px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
    @media (min-width: 850px) { .grid { grid-template-columns: 380px 1fr; } }
    .card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 14px; padding: 14px;
    }
    label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
    textarea, input, select {
      width: 100%; background: var(--panel2); color: var(--text);
      border: 1px solid var(--line); border-radius: 10px; padding: 10px;
      font-size: 14px; outline: none;
    }
    input[type="range"] { padding: 0; }
    textarea { min-height: 120px; resize: vertical; }
    button {
      border: 1px solid var(--line); background: var(--panel2); color: var(--text);
      padding: 10px 12px; border-radius: 10px; font-size: 14px; cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: #0c4a6e; border-color: #0369a1; }
    button.danger { background: #5f1717; border-color: #991b1b; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .row > * { flex: 1; }
    .row button { flex: 0 0 auto; }
    .status {
      font-size: 13px; color: var(--muted); margin-top: 10px;
      min-height: 18px; white-space: pre-wrap;
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.err { color: var(--danger); }
    .big {
      font-size: 18px; white-space: pre-wrap; min-height: 180px;
      background: var(--panel2); border: 1px solid var(--line);
      border-radius: 12px; padding: 14px;
    }
    .hint { color: var(--muted); font-size: 13px; }
    .history-item { border-top: 1px solid var(--line); padding: 12px 0; }
    .history-meta { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .history-text { white-space: pre-wrap; font-size: 14px; }
    .checkbox {
      display: flex; gap: 8px; align-items: center;
      color: var(--muted); font-size: 13px; margin-top: 10px;
    }
    .checkbox input { width: auto; }
    .meterwrap {
      position: relative; height: 14px; background: var(--panel2);
      border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: 8px;
    }
    #meterBar { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--ok); }
    #openMark  { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--danger); left: 0%; }
    #closeMark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--warn);   left: 0%; }
    #gateState {
      display: inline-block; margin-left: 8px; font-size: 12px; padding: 1px 8px;
      border-radius: 999px; border: 1px solid var(--line); color: var(--muted);
    }
    #gateState.open { color: #0b0d10; background: var(--ok); border-color: var(--ok); }
    .sliderval { color: var(--accent); font-size: 12px; }
    .legend { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .legend .dr { color: var(--danger); }
    .legend .dy { color: var(--warn); }
    details.help {
      margin-top: 14px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--panel2); padding: 0 12px;
    }
    details.help > summary {
      cursor: pointer; padding: 12px 0; font-size: 13px; color: var(--accent);
      list-style: none; user-select: none;
    }
    details.help > summary::-webkit-details-marker { display: none; }
    details.help > summary::before { content: "▸ "; }
    details.help[open] > summary::before { content: "▾ "; }
    details.help .body { padding: 0 0 12px; font-size: 13px; color: var(--text); }
    details.help h3 { font-size: 13px; margin: 12px 0 4px; color: var(--accent); }
    details.help p { margin: 4px 0; color: var(--muted); }
    details.help table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
    details.help td { border-top: 1px solid var(--line); padding: 6px 4px; vertical-align: top; }
    details.help td:first-child { color: var(--text); white-space: nowrap; padding-right: 10px; }
    details.help td:last-child { color: var(--muted); }
    details.help .tag { color: var(--danger); }
    details.help .tag.y { color: var(--warn); }
    kbd {
      background: #0f172a; border: 1px solid var(--line); border-radius: 6px;
      padding: 2px 6px; font-size: 12px; color: var(--text);
    }
    .divider { height: 1px; background: var(--line); margin: 18px 0 14px; }
  </style>
</head>

<body>
<main>
  <h1>ElevenLabs Scribe v2 Dictation (Realtime)</h1>

  <div class="grid">
    <section class="card">
      <div id="passphraseRow" style="display:none">
        <label for="passphrase">Passphrase</label>
        <input id="passphrase" type="password" placeholder="passphrase" autocomplete="off" />
      </div>

      <label for="apiKey" id="apiKeyLabel">ElevenLabs API key (optional)</label>
      <input id="apiKey" type="password" placeholder="xi-api-key" autocomplete="off" />

      <label class="checkbox">
        <input type="checkbox" id="saveApiKey" />
        Remember on this browser
      </label>

      <div class="row" style="margin-top: 10px;">
        <button id="forgetKeyBtn">Forget key</button>
      </div>

      <div class="row" style="margin-top: 14px;">
        <button id="recordBtn" class="primary">Start recording</button>
        <button id="clearBtn">Clear history</button>
      </div>

      <div class="divider"></div>

      <!-- Live Local Audio Routing Filters -->
      <label>Local Mic Level <span id="gateState">closed</span></label>
      <div class="meterwrap">
        <div id="meterBar"></div>
        <div id="closeMark"></div>
        <div id="openMark"></div>
      </div>
      <div class="legend" style="margin-bottom: 12px;">
        <span class="dr">red = OPEN threshold</span> &nbsp;|&nbsp;
        <span class="dy">yellow = CLOSE threshold</span>
      </div>

      <label for="gateOpen">Gate open threshold <span class="sliderval" id="gateOpenVal"></span></label>
      <input id="gateOpen" type="range" min="0" max="0.12" step="0.001" value="0.030" />

      <label for="gateClose">Gate close threshold <span class="sliderval" id="gateCloseVal"></span></label>
      <input id="gateClose" type="range" min="0" max="0.12" step="0.001" value="0.008" />

      <label for="highpass">High‑pass filter <span class="sliderval" id="highpassVal"></span></label>
      <input id="highpass" type="range" min="0" max="200" step="5" value="85" />

      <div class="divider"></div>

      <!-- Scribe VAD Performance Parameters -->
      <label style="font-weight: bold; color: var(--accent);">Scribe Realtime Filters</label>

      <label for="vadSilence">Scribe pause limit <span class="sliderval" id="vadSilenceVal"></span></label>
      <input id="vadSilence" type="range" min="0.3" max="3.0" step="0.1" value="2.0" />

      <label for="vadThreshold">Scribe noise filter <span class="sliderval" id="vadThresholdVal"></span></label>
      <input id="vadThreshold" type="range" min="0.1" max="0.9" step="0.05" value="0.55" />

      <label for="minSpeech">Scribe click filter <span class="sliderval" id="minSpeechVal"></span></label>
      <input id="minSpeech" type="range" min="50" max="1000" step="50" value="150" />

      <div class="divider"></div>

      <label class="checkbox">
        <input type="checkbox" id="noiseSuppress" />
        Browser noise suppression
      </label>

      <details class="help">
        <summary>How do these filter settings work? (tap to learn)</summary>
        <div class="body">
          <p><strong>Local Gate Controls:</strong> This acts on the audio before it gets saved into your local browser playback playbar.</p>
          <p><strong>Scribe Realtime Filters:</strong> Direct parameters piped to ElevenLabs' AI:
             <ul>
               <li><strong>Pause limit</strong>: Higher value (e.g. 2.0s) waits longer before finalizing. This reduces jumps ("less fast") and gives the AI context to correct grammar/spellings.</li>
               <li><strong>Noise filter</strong>: Higher values ignore quiet room hums, whispers, and background chatter.</li>
               <li><strong>Click filter</strong>: Higher values prevent brief clicks/rustling from being processed as speech.</li>
             </ul>
          </p>
        </div>
      </details>

      <div class="status" id="status">
        CapsLock via AHK: hold to record, release to stop. Browser beeps when text is
        ready on the clipboard — keep this tab focused until the beep, then switch
        windows and Ctrl+V.
      </div>

      <label for="keyterms">Context / vocabulary keyterms</label>
      <textarea id="keyterms" placeholder="One term per line. Examples:
tachycardia
ascites
right lower quadrant"></textarea>

      <div class="hint" id="keytermHint">
        Scribe v2 biases toward these terms. One per line, each &lt;= 20 chars, ≤5 words.
        <strong>Keyterms add ~20 % to cost.</strong> 0 / 50 terms.
      </div>

      <label for="timestamps">Timestamps</label>
      <select id="timestamps">
        <option value="none" selected>none</option>
        <option value="word">word</option>
      </select>

      <label class="checkbox">
        <input type="checkbox" id="noVerbatim" checked />
        Remove filler words / false starts
      </label>

      <label class="checkbox">
        <input type="checkbox" id="autoCopy" checked />
        Auto‑copy transcript to clipboard
      </label>

      <label class="checkbox">
        <input type="checkbox" id="appendMode" checked />
        Append consecutive recordings (don't clear)
      </label>

      <label class="checkbox">
        <input type="checkbox" id="stripNewlines" checked />
        Strip newlines (collapse to spaces)
      </label>

      <label class="checkbox">
        <input type="checkbox" id="trailingSpace" checked />
        Trailing space (for consecutive dictations)
      </label>

      <label class="checkbox">
        <input type="checkbox" id="startBeep" checked />
        Beep when recording starts
      </label>

      <label>Notes</label>
      <div class="hint">
        English‑only, Scribe v2. Mic is kept warm between dictations for instant start.
        Your browser opens a secure WebSocket pipe back to the Worker, transcribing speech incrementally.
      </div>
    </section>

    <section class="card">
      <div class="row">
        <button id="copyBtn">Copy latest</button>
        <button id="downloadBtn">Download .txt</button>
      </div>

      <label>Last recorded audio (captured locally)</label>
      <audio id="audioPreview" controls style="width:100%; margin-bottom:10px;"></audio>

      <div class="row">
        <button id="downloadAudioBtn">Download audio</button>
      </div>

      <label>Latest transcript</label>
      <div id="latest" class="big"></div>

      <div class="row" style="margin-top:14px;">
        <button id="toggleHistoryBtn">Show saved transcripts</button>
      </div>
      <div id="history" style="display:none;"></div>
    </section>
  </div>
</main>

<script>
(() => {
  const SHARED_MODE      = (__SHARED_MODE__);

  const apiKeyEl         = document.getElementById("apiKey");
  const apiKeyLabelEl    = document.getElementById("apiKeyLabel");
  const passphraseEl     = document.getElementById("passphrase");
  const passphraseRow    = document.getElementById("passphraseRow");
  const saveApiKeyEl     = document.getElementById("saveApiKey");
  const forgetKeyBtn     = document.getElementById("forgetKeyBtn");

  const recordBtn        = document.getElementById("recordBtn");
  const clearBtn         = document.getElementById("clearBtn");
  const copyBtn          = document.getElementById("copyBtn");
  const downloadBtn      = document.getElementById("downloadBtn");
  const downloadAudioBtn = document.getElementById("downloadAudioBtn");
  const toggleHistoryBtn = document.getElementById("toggleHistoryBtn");

  const statusEl         = document.getElementById("status");
  const latestEl         = document.getElementById("latest");
  const historyEl        = document.getElementById("history");
  const audioPreviewEl   = document.getElementById("audioPreview");

  const keytermsEl       = document.getElementById("keyterms");
  const keytermHintEl    = document.getElementById("keytermHint");
  const timestampsEl     = document.getElementById("timestamps");
  const noVerbatimEl     = document.getElementById("noVerbatim");
  const autoCopyEl       = document.getElementById("autoCopy");
  const appendModeEl     = document.getElementById("appendMode");
  const noiseSuppressEl  = document.getElementById("noiseSuppress");
  const startBeepEl      = document.getElementById("startBeep");
  const stripNewlinesEl  = document.getElementById("stripNewlines");
  const trailingSpaceEl  = document.getElementById("trailingSpace");

  const gateOpenEl       = document.getElementById("gateOpen");
  const gateCloseEl      = document.getElementById("gateClose");
  const gateOpenValEl    = document.getElementById("gateOpenVal");
  const gateCloseValEl   = document.getElementById("gateCloseVal");
  const highpassEl       = document.getElementById("highpass");
  const highpassValEl    = document.getElementById("highpassVal");

  // Realtime tuning VAD elements
  const vadSilenceEl     = document.getElementById("vadSilence");
  const vadThresholdEl   = document.getElementById("vadThreshold");
  const minSpeechEl      = document.getElementById("minSpeech");
  const vadSilenceValEl  = document.getElementById("vadSilenceVal");
  const vadThresholdValEl = document.getElementById("vadThresholdVal");
  const minSpeechValEl   = document.getElementById("minSpeechVal");

  const meterBar         = document.getElementById("meterBar");
  const openMark         = document.getElementById("openMark");
  const closeMark        = document.getElementById("closeMark");
  const gateStateEl      = document.getElementById("gateState");

  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let stopping = false;
  let stopRequested = false;
  let latestText = "";
  let lastAudioBlob = null;
  let lastAudioUrl = null;

  // Realtime Variables
  let ws = null;
  let finalizedSegments = [];
  let currentPartial = "";

  // Persistent audio nodes
  let stream = null;
  let audioCtx = null;
  let hpFilter = null;
  let analyserNode = null;
  let gateNode = null;
  let destNode = null;
  let recorderNode = null; // Node for real-time downsampling
  let sinkNode = null;     // Muted sink to keep ScriptProcessor running safely
  let gateTimer = null;
  let gateBuf = null;
  let gateIsOpen = false;
  let gateLastOpen = 0;
  let lastMeterPct = -1;

  let historyVisible = false;

  const METER_MAX    = 0.12;
  const HOLD_SECONDS = 0.9;
  const DICTATION_SENTINEL = "##DICTATION_FAILED##";

  const STORE_KEY              = "scribe_v2_transcripts_v9";
  const SETTINGS_KEY           = "scribe_v2_settings_v9";
  const API_KEY_STORAGE_KEY    = "elevenlabs_api_key_browser_v9";
  const PASSPHRASE_STORAGE_KEY = "scribe_v2_passphrase_v9";

  /* ───── Audio cues ───── */
  function beep(freq, ms, when) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + (when || 0);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
      setTimeout(() => ctx.close(), ((when || 0) + ms / 1000) * 1000 + 60);
    } catch (e) {}
  }

  function startBeep() { if (startBeepEl.checked) beep(760, 130); }
  function doneBeep()  { if (startBeepEl.checked) { beep(1046, 90, 0); beep(1568, 130, 0.10); } }
  function failBeep()  { if (startBeepEl.checked) beep(300, 280); }

  /* ───── Audio Downsampling & Float conversion helpers ───── */
  function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) return buffer;
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetInput = 0;
    while (offsetResult < result.length) {
      const nextOffsetInput = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0, count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetInput = nextOffsetInput;
    }
    return result;
  }

  // Converts float values to 16-bit signed PCM
  function floatTo16BitPCM(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output.buffer;
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  /* ───── Text processing ───── */
  function cleanTranscript(raw) {
    let t = raw;
    if (stripNewlinesEl.checked) {
      t = t.replace(/[\\r\\n]+/g, " ");
    }
    t = t.replace(/ +/g, " ").trim();
    if (trailingSpaceEl.checked && t.length > 0) t += " ";
    return t;
  }

  function updateLiveDisplay() {
    const combined = finalizedSegments.join(" ") + (currentPartial ? " " + currentPartial : "");
    const cleaned = cleanTranscript(combined);
    latestText = cleaned;
    latestEl.textContent = cleaned;
  }

  function setStatus(msg, cls) {
    statusEl.className = "status " + (cls || "");
    statusEl.textContent = msg;
  }

  function parseKeyterms(raw) {
    return raw
      .split(/[\\r\\n]+/)
      .map((s) => s.trim().replace(/\\s+/g, " ").replace(/[<>{}\\[\\]\\\\]/g, ""))
      .filter(Boolean)
      .filter((s) => s.length <= 20 && s.split(" ").length <= 5) // Fixed: <= 20 chars per Scribe API
      .slice(0, 50); // Real-time only accepts up to 50 keyterms
  }

  function updateKeytermHint() {
    const n = parseKeyterms(keytermsEl.value).length;
    keytermHintEl.innerHTML =
      "Scribe v2 biases toward these terms. One per line, each &lt;= 20 chars, ≤5 words. " +
      "<strong>Keyterms add ~20 % to cost.</strong> " + n + " / 50 terms.";
  }

  /* ───── Gate UI ───── */
  function enforceGateOrder(changed) {
    let open = Number(gateOpenEl.value);
    let close = Number(gateCloseEl.value);
    if (open < close) {
      if (changed === "open") gateCloseEl.value = String(open);
      else gateOpenEl.value = String(close);
    }
  }

  function updateGateLabels() {
    gateOpenValEl.textContent  = "(" + Number(gateOpenEl.value).toFixed(3) + ")";
    gateCloseValEl.textContent = "(" + Number(gateCloseEl.value).toFixed(3) + ")";
    highpassValEl.textContent  =
      Number(highpassEl.value) > 0 ? "(" + highpassEl.value + " Hz)" : "(off)";
    
    // Dynamic Scribe labels
    vadSilenceValEl.textContent = "(" + Number(vadSilenceEl.value).toFixed(1) + "s)";
    vadThresholdValEl.textContent = "(" + Number(vadThresholdEl.value).toFixed(2) + " - higher is less sensitive)";
    minSpeechValEl.textContent = "(" + Number(minSpeechEl.value) + " ms)";

    openMark.style.left  = Math.min(100, (Number(gateOpenEl.value)  / METER_MAX) * 100) + "%";
    closeMark.style.left = Math.min(100, (Number(gateCloseEl.value) / METER_MAX) * 100) + "%";
  }

  function setGateStateUI(isOpen) {
    gateStateEl.textContent = isOpen ? "OPEN" : "closed";
    gateStateEl.className  = isOpen ? "open" : "";
  }

  /* ───── Storage / Persistence ───── */
  let saveTimer = null;
  function saveSettings() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettingsNow, 250);
  }

  function saveSettingsNow() {
    const s = {
      keyterms:       keytermsEl.value,
      timestamps:     timestampsEl.value,
      noVerbatim:     noVerbatimEl.checked,
      autoCopy:       autoCopyEl.checked,
      appendMode:     appendModeEl.checked,
      saveApiKey:     saveApiKeyEl.checked,
      noiseSuppress:  noiseSuppressEl.checked,
      startBeep:      startBeepEl.checked,
      stripNewlines:  stripNewlinesEl.checked,
      trailingSpace:  trailingSpaceEl.checked,
      gateOpen:       gateOpenEl.value,
      gateClose:       gateCloseEl.value,
      highpass:       highpassEl.value,
      vadSilence:     vadSilenceEl.value,
      vadThreshold:   vadThresholdEl.value,
      minSpeech:      minSpeechEl.value,
      historyVisible: historyVisible,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

    if (saveApiKeyEl.checked) {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyEl.value.trim());
      if (passphraseEl) localStorage.setItem(PASSPHRASE_STORAGE_KEY, passphraseEl.value.trim());
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.keyterms) keytermsEl.value = s.keyterms;
      if (s.timestamps) timestampsEl.value = s.timestamps;
      if (typeof s.noVerbatim    === "boolean") noVerbatimEl.checked    = s.noVerbatim;
      if (typeof s.autoCopy      === "boolean") autoCopyEl.checked      = s.autoCopy;
      if (typeof s.appendMode    === "boolean") appendModeEl.checked    = s.appendMode;
      if (typeof s.saveApiKey    === "boolean") saveApiKeyEl.checked    = s.saveApiKey;
      if (typeof s.noiseSuppress === "boolean") noiseSuppressEl.checked = s.noiseSuppress;
      if (typeof s.startBeep     === "boolean") startBeepEl.checked     = s.startBeep;
      if (typeof s.stripNewlines === "boolean") stripNewlinesEl.checked = s.stripNewlines;
      if (typeof s.trailingSpace === "boolean") trailingSpaceEl.checked = s.trailingSpace;
      if (s.gateOpen  !== undefined) gateOpenEl.value  = s.gateOpen;
      if (s.gateClose !== undefined) gateCloseEl.value = s.gateClose;
      if (s.highpass  !== undefined) highpassEl.value  = s.highpass;
      if (s.vadSilence !== undefined) vadSilenceEl.value = s.vadSilence;
      if (s.vadThreshold !== undefined) vadThresholdEl.value = s.vadThreshold;
      if (s.minSpeech !== undefined) minSpeechEl.value = s.minSpeech;
      if (typeof s.historyVisible === "boolean") historyVisible = s.historyVisible;

      if (saveApiKeyEl.checked) {
        const k = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (k) apiKeyEl.value = k;
        const p = localStorage.getItem(PASSPHRASE_STORAGE_KEY);
        if (p && passphraseEl) passphraseEl.value = p;
      }
    } catch (e) {}
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function setHistory(items) {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 100)));
    renderHistory();
  }

  function addHistory(text, meta) {
    const items = getHistory();
    const entry = { text: text, createdAt: new Date().toISOString() };
    if (meta) {
      if (meta.language_code !== undefined) entry.language_code = meta.language_code;
    }
    items.unshift(entry);
    setHistory(items);
  }

  function applyHistoryVisibility() {
    const items = getHistory();
    historyEl.style.display = historyVisible ? "block" : "none";
    toggleHistoryBtn.textContent =
      (historyVisible ? "Hide saved transcripts" : "Show saved transcripts") +
      " (" + items.length + ")";
  }

  function renderHistory() {
    applyHistoryVisibility();
    if (!historyVisible) return;

    const items = getHistory();
    historyEl.innerHTML = "";

    if (!items.length) {
      historyEl.innerHTML = '<div class="hint">No transcripts yet.</div>';
      return;
    }

    for (const item of items) {
      const div = document.createElement("div");
      div.className = "history-item";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = new Date(item.createdAt).toLocaleString();

      const text = document.createElement("div");
      text.className = "history-text";
      text.textContent = item.text;

      const row = document.createElement("div");
      row.className = "row";
      row.style.marginTop = "8px";

      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.onclick = () => copyText(item.text);

      row.append(copy);
      div.append(meta, text, row);
      historyEl.append(div);
    }
  }

  /* ───── Clipboard ───── */
  async function clipboardWrite(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  async function copyText(text) {
    const ok = await clipboardWrite(text);
    setStatus(ok ? "Copied to clipboard."
                 : "Clipboard copy failed — keep this tab focused, then click 'Copy latest'.",
              ok ? "ok" : "err");
    return ok;
  }

  async function writeSentinel() {
    await clipboardWrite(DICTATION_SENTINEL);
  }

  /* ───── Real-time Audio Graph (mic → highpass → gate → script processor) ───── */
  async function ensureAudio() {
    if (stream && audioCtx && audioCtx.state !== "closed" && destNode) {
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch (e) {}
      }
      return true;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: noiseSuppressEl.checked,
        autoGainControl: false,
        sampleRate: 48000,
      },
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (e) {}
    }

    const source = audioCtx.createMediaStreamSource(stream);

    hpFilter = audioCtx.createBiquadFilter();
    hpFilter.type = "highpass";
    hpFilter.frequency.value = Number(highpassEl.value) || 0;
    hpFilter.Q.value = 0.707;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;

    gateNode = audioCtx.createGain();
    gateNode.gain.value = 0;

    destNode = audioCtx.createMediaStreamDestination();
    recorderNode = audioCtx.createScriptProcessor(4096, 1, 1);

    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;

    source.connect(hpFilter);
    hpFilter.connect(analyserNode);

    // STT FEED: pre-gate (raw, high-passed) audio -> Scribe.
    hpFilter.connect(recorderNode);
    recorderNode.connect(sinkNode);
    sinkNode.connect(audioCtx.destination);

    // LOCAL RECORDING ONLY: keep the noise gate on the playback file.
    hpFilter.connect(gateNode);
    gateNode.connect(destNode);

    gateBuf = new Float32Array(analyserNode.fftSize);
    gateIsOpen = false;
    gateLastOpen = 0;
    lastMeterPct = -1;
    setGateStateUI(false);

    // Audio sampling loop
    recorderNode.onaudioprocess = (e) => {
      if (!recording || stopping || !ws || ws.readyState !== WebSocket.OPEN) return;

      const floatSamples = e.inputBuffer.getChannelData(0);
      
      const downsampled = downsampleBuffer(floatSamples, audioCtx.sampleRate, 16000);
      const pcmBuffer = floatTo16BitPCM(downsampled);
      const base64Audio = arrayBufferToBase64(pcmBuffer);

      ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64Audio
      }));
    };

    if (gateTimer) clearInterval(gateTimer);
    gateTimer = setInterval(() => {
      if (!analyserNode || !audioCtx) return;

      analyserNode.getFloatTimeDomainData(gateBuf);
      let sum = 0;
      for (let i = 0; i < gateBuf.length; i++) sum += gateBuf[i] * gateBuf[i];
      const rms = Math.sqrt(sum / gateBuf.length);

      const pct = Math.min(100, (rms / METER_MAX) * 100);
      if (Math.abs(pct - lastMeterPct) > 0.5) {
        meterBar.style.width = pct + "%";
        lastMeterPct = pct;
      }

      const openT  = Number(gateOpenEl.value);
      const closeT = Number(gateCloseEl.value);
      const now    = audioCtx.currentTime;

      if (!gateIsOpen) {
        if (rms > openT) {
          gateIsOpen = true;
          gateLastOpen = now;
          gateNode.gain.setTargetAtTime(1, now, 0.02);
          setGateStateUI(true);
        }
      } else {
        if (rms > closeT) {
          gateLastOpen = now;
        } else if (now - gateLastOpen > HOLD_SECONDS) {
          gateIsOpen = false;
          gateNode.gain.setTargetAtTime(0, now, 0.12);
          setGateStateUI(false);
        }
      }
    }, 30);

    return true;
  }

  function releaseAudio() {
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); }
    if (stream) { for (const track of stream.getTracks()) track.stop(); }
    stream = null; audioCtx = null; hpFilter = null; analyserNode = null;
    gateNode = null; destNode = null; recorderNode = null; sinkNode = null; gateBuf = null; gateIsOpen = false;
    lastMeterPct = -1;
    meterBar.style.width = "0%";
    setGateStateUI(false);
  }

  async function tryWarmOnLoad() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: "microphone" });
        if (st.state === "granted") ensureAudio().catch(() => {});
      }
    } catch (e) {}
  }

  /* ───── Stream Audio & Run WebSocket Session ───── */
  async function startRecording() {
    if (recording || stopping) return;
    stopRequested = false;

    const apiKey = apiKeyEl.value.trim();
    if (!apiKey && !(SHARED_MODE && passphraseEl.value.trim())) {
      await writeSentinel();
      if (SHARED_MODE) {
        setStatus("Enter the shared passphrase first.", "err");
        passphraseEl.focus();
      } else {
        setStatus("Enter your ElevenLabs API key first.", "err");
        apiKeyEl.focus();
      }
      failBeep();
      return;
    }

    saveSettingsNow();

    try {
      await ensureAudio();
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
      if (!audioCtx || audioCtx.state !== "running") {
        await writeSentinel();
        setStatus("Audio not running. Click page once, then try again.", "err");
        failBeep();
        return;
      }
    } catch (e) {
      await writeSentinel();
      setStatus("Microphone unavailable: " + (e && e.message ? e.message : e), "err");
      failBeep();
      return;
    }

    // Reset transcription buffers ONLY if appendMode is off [3]
    if (!appendModeEl.checked) {
      finalizedSegments = [];
    }
    currentPartial = "";
    updateLiveDisplay();

    // Establish Secure Proxy WebSocket Connection through the Cloudflare Worker
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    if (apiKey) params.append("api_key", apiKey);
    if (SHARED_MODE) params.append("passphrase", passphraseEl.value.trim());
    params.append("no_verbatim", String(noVerbatimEl.checked));
    params.append("timestamps", timestampsEl.value);

    // Pass custom server-side VAD parameters [3]
    params.append("vad_silence_threshold_secs", vadSilenceEl.value);
    params.append("vad_threshold", vadThresholdEl.value);
    params.append("min_speech_duration_ms", minSpeechEl.value);

    const keyterms = parseKeyterms(keytermsEl.value);
    params.append("keyterms_json", JSON.stringify(keyterms));

    const wsUrl = wsProtocol + "//" + window.location.host + "/api/transcribe?" + params.toString();
    
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      await writeSentinel();
      setStatus("Could not open transcription pipeline.", "err");
      failBeep();
      return;
    }

    ws.onopen = () => {
      setStatus("WebSocket Connected. Transcribing live...", "ok");
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        const m_type = data.message_type;

        if (m_type === "partial_transcript") {
          currentPartial = data.text;
          updateLiveDisplay();
        } 
        else if (m_type === "committed_transcript" || m_type === "committed_transcript_with_timestamps") {
          if (data.text && data.text.trim()) {
            finalizedSegments.push(data.text);
            currentPartial = "";
            updateLiveDisplay();
          }
        } 
        else if (m_type === "error") {
          console.error("ElevenLabs Session Error:", data.error);
          setStatus("ElevenLabs returned error: " + data.error, "err");
          failBeep();
        }
      } catch (err) {
        console.error("Error processing message:", err);
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket Error:", err);
      setStatus("Pipeline connection error.", "err");
    };

    ws.onclose = () => {
      console.log("WebSocket connection closed.");
      finalizeSession();
    };

    // Parallel local audio recording for playback bar
    chunks = [];
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported(type));

    try {
      mediaRecorder = new MediaRecorder(
        destNode.stream,
        preferred ? { mimeType: preferred } : undefined
      );
    } catch (e) {
      console.warn("Local browser playbar preview recorder failed to initiate.");
    }

    if (mediaRecorder) {
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start();
    }

    recording = true;
    stopping = false;
    recordBtn.textContent = "Stop recording";
    recordBtn.classList.add("danger");
    startBeep();

    if (stopRequested) {
      stopRequested = false;
      stopRecording();
    }
  }

  function stopRecording() {
    if (!recording || stopping) {
      stopRequested = true;
      return;
    }
    stopping = true;
    setStatus("Finalizing live speech transcript...", "warn");
    
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }

    // Wait 1.2 seconds for Scribe to output remaining audio packets, then close
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Send a final empty flush chunk with commit: true to commit the last segment
        ws.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true
        }));
        ws.close();
      } else {
        finalizeSession();
      }
    }, 1200);
  }

  async function finalizeSession() {
    recording = false;
    stopping = false;
    recordBtn.textContent = "Start recording";
    recordBtn.classList.remove("danger");

    if (chunks.length) {
      const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "audio/webm" });
      lastAudioBlob = blob;
      if (lastAudioUrl) URL.revokeObjectURL(lastAudioUrl);
      lastAudioUrl = URL.createObjectURL(blob);
      audioPreviewEl.src = lastAudioUrl;
    }

    const cleaned = cleanTranscript(latestText);

    if (!cleaned.trim()) {
      await writeSentinel();
      setStatus("No speech detected.", "warn");
      failBeep();
      return;
    }

    // Save final clean output to browser storage
    addHistory(cleaned, { language_code: "en" });

    if (autoCopyEl.checked) {
      const copied = await copyText(cleaned);
      setStatus(
        copied ? "Live transcript saved & copied. Done!"
               : "Live transcript saved — copy FAILED (keep tab focused; click 'Copy latest').",
        copied ? "ok" : "warn"
      );
    } else {
      setStatus("Live transcript saved.", "ok");
    }

    doneBeep();
  }

  /* ───── Controls & Event Listeners ───── */
  recordBtn.onclick = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  forgetKeyBtn.onclick = () => {
    apiKeyEl.value = "";
    if (passphraseEl) passphraseEl.value = "";
    saveApiKeyEl.checked = false;
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    saveSettingsNow();
    setStatus(SHARED_MODE ? "Shared passphrase / key removed." : "API key removed.", "ok");
  };

  clearBtn.onclick = () => {
    localStorage.removeItem(STORE_KEY);
    latestText = "";
    latestEl.textContent = "";
    finalizedSegments = []; // Fixed: Make sure screen buffer is cleared alongside history
    currentPartial = "";
    renderHistory();
    setStatus("History cleared.");
  };

  copyBtn.onclick = () => { if (latestText) copyText(latestText); };

  toggleHistoryBtn.onclick = () => {
    historyVisible = !historyVisible;
    saveSettingsNow();
    renderHistory();
  };

  downloadBtn.onclick = () => {
    const items = getHistory();
    const body = items.map((i) => {
      return "=== " + new Date(i.createdAt).toLocaleString() + " ===\\n" + i.text;
    }).join("\\n\\n");

    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = "scribe-v2-transcripts.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  downloadAudioBtn.onclick = () => {
    if (!lastAudioBlob) {
      setStatus("No audio recorded yet.", "warn");
      return;
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(lastAudioBlob);
    a.href = url;
    a.download = "last-recording.webm";
    a.click();
    URL.revokeObjectURL(url);
  };

  gateOpenEl.addEventListener("input", () => {
    enforceGateOrder("open"); updateGateLabels(); saveSettings();
  });
  gateCloseEl.addEventListener("input", () => {
    enforceGateOrder("close"); updateGateLabels(); saveSettings();
  });
  highpassEl.addEventListener("input", () => {
    if (hpFilter) hpFilter.frequency.value = Number(highpassEl.value) || 0;
    updateGateLabels();
    saveSettings();
  });

  // Dynamic Scribe event listeners
  vadSilenceEl.addEventListener("input", () => { updateGateLabels(); saveSettings(); });
  vadThresholdEl.addEventListener("input", () => { updateGateLabels(); saveSettings(); });
  minSpeechEl.addEventListener("input", () => { updateGateLabels(); saveSettings(); });

  keytermsEl.addEventListener("input", updateKeytermHint);

  noiseSuppressEl.addEventListener("change", () => {
    releaseAudio();
    tryWarmOnLoad();
  });

  for (const el of [
    apiKeyEl, saveApiKeyEl, keytermsEl, timestampsEl,
    noVerbatimEl, autoCopyEl, appendModeEl, startBeepEl,
    stripNewlinesEl, trailingSpaceEl,
  ]) {
    el.addEventListener("change", saveSettings);
    el.addEventListener("input", saveSettings);
  }

  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "F13") {
      e.preventDefault();
      if (!recording && !stopping) startRecording();
      return;
    }
    if (e.code === "F14") {
      e.preventDefault();
      if (recording || stopRequested) stopRecording();
      return;
    }
  });

  window.addEventListener("beforeunload", () => {
    try { releaseAudio(); } catch (e) {}
  });

  if (SHARED_MODE) {
    passphraseRow.style.display = "";
    if (apiKeyLabelEl) apiKeyLabelEl.textContent = "ElevenLabs API key (optional — shared passphrase access in use)";
    apiKeyEl.placeholder = "optional — leave blank to use the shared passphrase";
  }

  loadSettings();
  updateGateLabels();
  updateKeytermHint();
  renderHistory();
  tryWarmOnLoad();
})();
</script>
</body>
</html>`;
