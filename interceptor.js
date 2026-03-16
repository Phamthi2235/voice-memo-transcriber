/**
 * Voice Memo Transcriber
 * Runs at document_start in MAIN world - BEFORE the page's own code.
 * Intercepts all audio APIs to capture voice message data.
 */

(function () {
  "use strict";

  const LOG_PREFIX = "[MsgTranscriber]";
  const VERSION = "3.0-serverless";
  console.log(LOG_PREFIX, "Loaded version:", VERSION);

  // --- Bridge communication helpers (MAIN world → bridge.js → background.js) ---
  let _msgId = 0;
  const _pendingMessages = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const { type, id } = event.data || {};
    if ((type === "mst-transcribe-response" || type === "mst-summarize-response") && _pendingMessages.has(id)) {
      _pendingMessages.get(id)(event.data);
      _pendingMessages.delete(id);
    }
  });

  function sendToBridge(msgType, payload) {
    return new Promise((resolve) => {
      const id = ++_msgId;
      _pendingMessages.set(id, resolve);
      window.postMessage({ type: msgType, id, ...payload }, "*");
    });
  }

  // --- Site detection ---
  const SITE = window.location.hostname.includes("whatsapp") ? "whatsapp" : "messenger";
  console.log(LOG_PREFIX, "Detected site:", SITE);

  // Storage: blobUrl -> { rawBuffer, blob, type, size }
  window.__msgTranscriber = {
    blobMap: new Map(),       // blobUrl -> audio data
    lastPlayedUrl: null,      // last blobUrl that was played
    audioContexts: [],
  };

  console.log(LOG_PREFIX, "Early interceptor loaded - BEFORE page code");

  // ========== 1. Intercept AudioContext creation ==========
  const OrigAudioContext = window.AudioContext;
  const OrigWebkitAudioContext = window.webkitAudioContext;

  window.AudioContext = function (...args) {
    const ctx = new OrigAudioContext(...args);
    window.__msgTranscriber.audioContexts.push(ctx);
    patchAudioContext(ctx);
    return ctx;
  };
  window.AudioContext.prototype = OrigAudioContext.prototype;
  Object.setPrototypeOf(window.AudioContext, OrigAudioContext);

  if (OrigWebkitAudioContext) {
    window.webkitAudioContext = window.AudioContext;
  }

  // ========== 2. Patch AudioContext.decodeAudioData ==========
  function patchAudioContext(ctx) {
    const origDecode = ctx.decodeAudioData.bind(ctx);
    ctx.decodeAudioData = function (arrayBuffer, successCb, errorCb) {
      const bufferCopy = arrayBuffer.slice(0);
      const wrappedSuccess = function (audioBuffer) {
        if (successCb) successCb(audioBuffer);
      };
      if (successCb) {
        return origDecode(arrayBuffer, wrappedSuccess, errorCb);
      } else {
        return origDecode(arrayBuffer);
      }
    };
  }

  // ========== 3. Intercept URL.createObjectURL ==========
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(this, obj);
    if (obj instanceof Blob) {
      const isAudio = obj.type.startsWith("audio/");
      if (isAudio) {
        console.log(LOG_PREFIX, "Captured audio blob:", obj.type, obj.size, "bytes", url);
        obj.arrayBuffer().then((buf) => {
          window.__msgTranscriber.blobMap.set(url, {
            rawBuffer: buf,
            blob: obj,
            blobUrl: url,
            type: obj.type,
            size: obj.size,
          });
        });
      }
    }
    return url;
  };

  // ========== 4. Intercept HTMLMediaElement.play to track which blobUrl plays ==========
  const origMediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (this.src && this.src.startsWith("blob:")) {
      window.__msgTranscriber.lastPlayedUrl = this.src;
      console.log(LOG_PREFIX, "Play blob:", this.src);
      // If transcriber triggered this play, keep it muted
      if (window.__msgTranscriber._silentCapture) {
        this.muted = true;
        this.volume = 0;
      }
    }
    return origMediaPlay.call(this);
  };

  // ========== 5. Intercept fetch for audio ==========
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    return origFetch.apply(this, args).then((response) => {
      const ct = response.headers?.get("content-type") || "";
      if (ct.includes("audio") || ct.includes("ogg")) {
        const cloned = response.clone();
        cloned.arrayBuffer().then((buf) => {
          if (buf.byteLength > 1000) {
            const fakeUrl = "fetch:" + url.substring(0, 200) + ":" + Date.now();
            window.__msgTranscriber.blobMap.set(fakeUrl, {
              rawBuffer: buf,
              type: ct,
              size: buf.byteLength,
            });
          }
        });
      }
      return response;
    });
  };

  // ========== 6. Inject global styles ==========
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes mst-pulse {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }
      @keyframes mst-shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      @keyframes mst-fadein {
        from { opacity: 0; transform: translateY(-6px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes mst-bar {
        0%, 100% { transform: scaleY(0.3); }
        50% { transform: scaleY(1); }
      }
      @keyframes mst-border-rotate {
        0% { --mst-angle: 0deg; }
        100% { --mst-angle: 360deg; }
      }
      @keyframes mst-gradient-shift {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes mst-text-shimmer {
        0% { background-position: -100% 0; }
        100% { background-position: 200% 0; }
      }

      @property --mst-angle {
        syntax: '<angle>';
        initial-value: 0deg;
        inherits: false;
      }

      .mst-wrapper {
        display: flex;
        flex-direction: column;
        padding: 6px 12px;
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: transparent !important;
        border-radius: 0 0 12px 12px;
        max-width: 65%;
      }
      .mst-wrapper.mst-own {
        align-items: flex-end;
      }
      .mst-wrapper.mst-other {
        align-items: flex-start;
      }

      /* ===== Button — Soft warm glass pill ===== */
      @keyframes mst-btn-glow {
        0%, 100% { box-shadow: 0 2px 8px rgba(139, 92, 246, 0.12), 0 0 0 rgba(236, 72, 153, 0); }
        50% { box-shadow: 0 3px 12px rgba(139, 92, 246, 0.2), 0 0 20px rgba(236, 72, 153, 0.06); }
      }
      .mst-btn {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 5px 13px 5px 8px;
        margin: 3px 0;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        color: #6b5ce7;
        cursor: pointer;
        border: 1px solid rgba(139, 92, 246, 0.15);
        background: linear-gradient(135deg, rgba(255,255,255,0.95), rgba(245, 243, 255, 0.9));
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-radius: 20px;
        transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        letter-spacing: 0.03em;
        position: relative;
        animation: mst-btn-glow 3s ease-in-out infinite;
      }
      .mst-btn:hover {
        background: linear-gradient(135deg, rgba(245, 243, 255, 1), rgba(237, 233, 254, 0.95));
        color: #5b4bd4;
        transform: translateY(-1px) scale(1.03);
        border-color: rgba(139, 92, 246, 0.3);
        box-shadow: 0 6px 20px rgba(139, 92, 246, 0.2), 0 0 30px rgba(167, 139, 250, 0.1);
      }
      .mst-btn:active {
        transform: translateY(0) scale(0.98);
        box-shadow: 0 2px 6px rgba(139, 92, 246, 0.15);
      }

      .mst-btn-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: linear-gradient(135deg, #8b5cf6, #a78bfa);
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(139, 92, 246, 0.3), inset 0 1px 0 rgba(255,255,255,0.2);
      }
      .mst-btn-icon svg {
        width: 11px;
        height: 11px;
        fill: white;
      }

      .mst-btn.mst-loading {
        color: #a78bfa;
        pointer-events: none;
      }
      .mst-btn.mst-loading .mst-btn-icon {
        animation: mst-pulse 1.2s ease-in-out infinite;
      }

      /* ===== Transcript Box — Glassmorphism + Animated Border ===== */
      .mst-transcript-box {
        display: none;
        margin: 6px 0;
        border-radius: 16px;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.7;
        max-width: 480px;
        word-wrap: break-word;
        animation: mst-fadein 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        overflow: hidden;
      }

      /* Status box (loading states) */
      .mst-transcript-box.mst-status {
        padding: 16px 18px;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.08), rgba(236, 72, 153, 0.06));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #7c3aed;
        border: 1px solid rgba(139, 92, 246, 0.18);
        font-weight: 500;
      }

      /* Result box — solid background, no blur-through from parent */
      .mst-transcript-box.mst-result {
        padding: 0;
        color: #1e1b4b;
        border: none;
      }

      .mst-transcript-box.mst-error {
        padding: 16px 18px;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(244, 63, 94, 0.06));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #dc2626;
        border: 1px solid rgba(220, 38, 38, 0.2);
      }

      /* ===== Animated Gradient Border Wrapper ===== */
      .mst-border-wrap {
        position: relative;
        border-radius: 16px;
        padding: 2px;
        background: conic-gradient(from var(--mst-angle, 0deg), var(--mst-c1), var(--mst-c2), var(--mst-c3), var(--mst-c1));
        animation: mst-border-rotate 4s linear infinite;
        box-shadow: var(--mst-glow);
      }
      .mst-border-inner {
        border-radius: 14px;
        overflow: hidden;
        position: relative;
        background: var(--mst-bg);
      }

      /* ===== Transcript Header Bar ===== */
      .mst-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        font-size: 12px;
        font-weight: 600;
        color: var(--mst-header-color, #6d28d9);
        border-bottom: 1px solid var(--mst-divider, rgba(139, 92, 246, 0.12));
        background: var(--mst-header-bg, rgba(139, 92, 246, 0.04));
        position: relative;
      }
      .mst-header::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 16px;
        right: 16px;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--mst-header-color, rgba(139, 92, 246, 0.2)), transparent);
      }
      .mst-header-emoji {
        font-size: 16px;
        line-height: 1;
      }
      .mst-header-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--mst-badge-bg, rgba(139, 92, 246, 0.1));
        color: var(--mst-badge-color, #7c3aed);
      }
      .mst-header-duration {
        margin-left: auto;
        font-size: 11px;
        opacity: 0.7;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }

      /* ===== Transcript Text Content with Decorative Quotes ===== */
      .mst-text-content {
        padding: 16px 20px 18px;
        position: relative;
      }
      .mst-text-content::before {
        content: '\\201C';
        position: absolute;
        top: 4px;
        left: 6px;
        font-size: 42px;
        font-family: Georgia, 'Times New Roman', serif;
        color: var(--mst-quote-color, rgba(139, 92, 246, 0.15));
        line-height: 1;
        pointer-events: none;
      }
      .mst-text-content::after {
        content: '\\201D';
        position: absolute;
        bottom: 2px;
        right: 8px;
        font-size: 42px;
        font-family: Georgia, 'Times New Roman', serif;
        color: var(--mst-quote-color, rgba(139, 92, 246, 0.15));
        line-height: 1;
        pointer-events: none;
      }
      .mst-text-inner {
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        position: relative;
        z-index: 1;
      }

      /* ===== Energy Bar — Taller + Glow ===== */
      .mst-energy-bar {
        position: relative;
        height: 5px;
        overflow: hidden;
        display: flex;
        gap: 1px;
      }
      .mst-energy-bar .mst-bar-segment {
        flex: 1;
        border-radius: 0 0 1px 1px;
        transform-origin: bottom;
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      }

      /* ===== Vibe Banner ===== */
      .mst-vibe-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.06), rgba(236, 72, 153, 0.04), rgba(251, 191, 36, 0.03));
        border-bottom: 1px solid rgba(139, 92, 246, 0.08);
        font-family: inherit;
      }
      .mst-vibe-emoji {
        font-size: 28px;
        line-height: 1;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
        animation: mst-vibe-pop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }
      @keyframes mst-vibe-pop {
        0% { transform: scale(0); opacity: 0; }
        60% { transform: scale(1.3); }
        100% { transform: scale(1); opacity: 1; }
      }
      .mst-vibe-text {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .mst-vibe-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #9ca3af;
      }
      .mst-vibe-mood {
        font-size: 14px;
        font-weight: 600;
        color: #4c1d95;
        line-height: 1.2;
      }
      .mst-vibe-energy {
        margin-left: auto;
        display: flex;
        gap: 3px;
        align-items: center;
      }
      .mst-vibe-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #d1d5db;
        transition: background 0.3s;
      }
      .mst-vibe-dot.active {
        background: linear-gradient(135deg, #8b5cf6, #ec4899);
        box-shadow: 0 0 6px rgba(139, 92, 246, 0.5);
      }

      /* ===== Summary Section ===== */
      .mst-summary-section {
        padding: 14px 20px 12px;
        position: relative;
      }
      .mst-summary-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #9ca3af;
      }
      .mst-summary-header::after {
        content: '';
        flex: 1;
        height: 1px;
        background: linear-gradient(90deg, rgba(139, 92, 246, 0.15), transparent);
      }
      .mst-summary-text {
        font-size: 14px;
        font-weight: 500;
        line-height: 1.6;
        color: #4c1d95;
        padding: 0;
      }
      .mst-summary-text.mst-loading {
        background: linear-gradient(90deg, #8b5cf6, #d946ef, #ec4899, #8b5cf6);
        background-size: 300% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: mst-text-shimmer 2s ease-in-out infinite;
      }
      .mst-summary-toggle {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-top: 10px;
        padding: 4px 0;
        font-size: 11.5px;
        font-weight: 600;
        color: #8b5cf6;
        cursor: pointer;
        border: none;
        background: none;
        font-family: inherit;
        transition: color 0.2s;
      }
      .mst-summary-toggle:hover {
        color: #6d28d9;
      }
      .mst-summary-toggle .mst-toggle-arrow {
        display: inline-block;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        font-size: 10px;
      }
      .mst-summary-toggle.mst-expanded .mst-toggle-arrow {
        transform: rotate(180deg);
      }
      .mst-full-transcript {
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        transition: max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
      }
      .mst-full-transcript.mst-open {
        max-height: 5000px;
        opacity: 1;
      }
      .mst-transcript-divider {
        height: 1px;
        margin: 0 20px;
        background: linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.12), transparent);
      }

      /* ===== Loading Shimmer — Bigger + More Vivid ===== */
      .mst-shimmer {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(90deg, transparent 0%, rgba(139, 92, 246, 0.08) 25%, rgba(236, 72, 153, 0.08) 50%, rgba(139, 92, 246, 0.08) 75%, transparent 100%);
        background-size: 200% 100%;
        animation: mst-shimmer 1.8s ease-in-out infinite;
        pointer-events: none;
      }

      /* ===== Gradient Loading Text ===== */
      .mst-loading-text {
        background: linear-gradient(90deg, #8b5cf6, #d946ef, #ec4899, #8b5cf6);
        background-size: 300% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: mst-text-shimmer 2.5s ease-in-out infinite;
        font-weight: 600;
      }

      /* Mini waveform in button */
      .mst-mini-wave {
        display: inline-flex;
        align-items: center;
        gap: 1.5px;
        height: 14px;
        margin-left: 2px;
      }
      .mst-mini-wave .mst-mini-bar {
        width: 2px;
        border-radius: 1px;
        background: currentColor;
        opacity: 0.5;
      }
      .mst-btn.mst-loading .mst-mini-wave .mst-mini-bar {
        animation: mst-bar 0.8s ease-in-out infinite;
      }

      /* Mood indicator dot */
      .mst-mood {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        margin-left: 4px;
        vertical-align: middle;
        animation: mst-pulse 2s ease-in-out infinite;
        box-shadow: 0 0 6px currentColor;
      }

      /* ===== Expressive Words — Volume-based styling + reading animation ===== */
      @keyframes mst-read-in {
        0% {
          opacity: 0.55;
          filter: saturate(0.5);
        }
        100% {
          opacity: 1;
          filter: saturate(1);
        }
      }
      .mst-segment {
        padding: 2px 0;
        border-radius: 4px;
        transition: border-color 0.3s ease;
      }
      .mst-word {
        display: inline;
        line-height: 2.1;
        border-radius: 2px;
        padding: 0 1px;
        cursor: default;
        opacity: 0.55;
        animation: mst-read-in 0.4s ease-out forwards;
        animation-delay: var(--mst-read-delay, 0s);
        transition: filter 0.15s ease, transform 0.15s ease;
      }
      .mst-word:hover {
        filter: brightness(1.3);
        transform: scale(1.05);
        display: inline-block;
      }
    `;
    document.head.appendChild(style);
  }

  // ========== 7. UI: Add transcript buttons ==========
  function waitForDOM() {
    if (document.body) {
      initUI();
    } else {
      document.addEventListener("DOMContentLoaded", initUI);
    }
  }

  function initUI() {
    console.log(LOG_PREFIX, "DOM ready, starting UI scan");
    injectStyles();
    setInterval(scan, 2000);
    setTimeout(scan, 1000);
  }

  function scan() {
    if (SITE === "whatsapp") {
      // WhatsApp Web: find voice message play buttons
      const playBtns = document.querySelectorAll(
        'button[aria-label="Play voice message"], button[aria-label="Play"], [data-testid="audio-play"]'
      );
      playBtns.forEach((playBtn) => {
        const row = playBtn.closest('[data-id]') || playBtn.closest('[role="row"]');
        if (!row) return;
        if (row.dataset.transcriptAdded) return;
        if (row.querySelector('[data-testid="video-player"]')) return;
        addTranscriptButton(row, playBtn);
      });
    } else {
      // Messenger: find voice message rows
      const rows = document.querySelectorAll('[role="row"]');
      rows.forEach((row) => {
        const playBtn = row.querySelector('[aria-label="Play"]') || row.querySelector('[aria-label="Pause"]');
        if (!playBtn) return;
        if (row.querySelector('[aria-label="Play Video"]')) return;
        if (row.dataset.transcriptAdded) return;
        addTranscriptButton(row, playBtn);
      });
    }
  }

  function getAudioForRow(row) {
    const durText = row.innerText.match(/(\d+):(\d+)/);
    if (!durText) return null;
    const durationSec = parseInt(durText[1]) * 60 + parseInt(durText[2]);

    const blobs = [...window.__msgTranscriber.blobMap.values()];
    if (blobs.length === 0) return null;

    let bestMatch = null;
    let bestDiff = Infinity;
    for (const blob of blobs) {
      if (blob._used) continue;
      const estimatedDur = blob.size / 16000;
      const diff = Math.abs(estimatedDur - durationSec);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = blob;
      }
    }
    return bestMatch;
  }

  // ========== Audio Amplitude Analysis ==========
  async function analyzeAmplitude(rawBuffer) {
    try {
      const ctx = new OrigAudioContext();
      const audioBuffer = await ctx.decodeAudioData(rawBuffer.slice(0));
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const windowMs = 50;
      const windowSize = Math.floor(sampleRate * windowMs / 1000);

      const amplitudes = [];
      for (let i = 0; i < channelData.length; i += windowSize) {
        let sumSquares = 0;
        const end = Math.min(i + windowSize, channelData.length);
        for (let j = i; j < end; j++) {
          sumSquares += channelData[j] * channelData[j];
        }
        amplitudes.push(Math.sqrt(sumSquares / (end - i)));
      }

      const maxAmp = Math.max(...amplitudes);
      if (maxAmp > 0) {
        for (let i = 0; i < amplitudes.length; i++) {
          amplitudes[i] = amplitudes[i] / maxAmp;
        }
      }

      ctx.close().catch(() => {});
      console.log(LOG_PREFIX, "Amplitude analysis:", amplitudes.length, "samples");
      return { amplitudes, windowMs, duration: audioBuffer.duration };
    } catch (err) {
      console.warn(LOG_PREFIX, "Amplitude analysis failed:", err);
      return null;
    }
  }

  function getVolumeForTimeRange(ampData, start, end) {
    if (!ampData) return 0.5;
    const { amplitudes, windowMs } = ampData;
    const msPerWindow = windowMs / 1000;
    const startIdx = Math.floor(start / msPerWindow);
    const endIdx = Math.min(Math.ceil(end / msPerWindow), amplitudes.length);
    if (startIdx >= endIdx) return 0.5;

    let sum = 0;
    for (let i = startIdx; i < endIdx; i++) {
      sum += amplitudes[i];
    }
    return sum / (endIdx - startIdx);
  }

  // Color interpolation: cold slate → purple → magenta → rose → gold (like a flame)
  function volumeToColor(v) {
    const stops = [
      { pos: 0.0,  r: 148, g: 163, b: 184 },
      { pos: 0.25, r: 167, g: 139, b: 250 },
      { pos: 0.5,  r: 139, g: 92,  b: 246 },
      { pos: 0.7,  r: 192, g: 38,  b: 211 },
      { pos: 0.85, r: 225, g: 29,  b: 72  },
      { pos: 1.0,  r: 245, g: 158, b: 11  },
    ];

    let lower = stops[0], upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (v >= stops[i].pos && v <= stops[i + 1].pos) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }

    const t = upper.pos === lower.pos ? 0 : (v - lower.pos) / (upper.pos - lower.pos);
    return {
      r: Math.round(lower.r + t * (upper.r - lower.r)),
      g: Math.round(lower.g + t * (upper.g - lower.g)),
      b: Math.round(lower.b + t * (upper.b - lower.b)),
    };
  }

  function volumeToStyle(volume) {
    const v = Math.max(0, Math.min(1, volume));
    // Big range: whispering 12.5px/300 → shouting 22px/800
    const fontSize = 12.5 + v * 9.5;
    const fontWeight = Math.round(300 + v * 500);
    const opacity = 0.75 + v * 0.25;
    const letterSpacing = (0.02 - v * 0.03) + "em"; // whisper: wide, loud: compact
    return { fontSize, fontWeight, opacity, letterSpacing };
  }

  // Smooth reading gradient: warm purple → magenta → pink → violet
  function positionToColor(pos) {
    const stops = [
      { pos: 0.0,  r: 109, g: 40,  b: 217 },  // violet-700
      { pos: 0.25, r: 139, g: 92,  b: 246 },  // violet-500
      { pos: 0.5,  r: 192, g: 38,  b: 211 },  // fuchsia-600
      { pos: 0.75, r: 236, g: 72,  b: 153 },  // pink-500
      { pos: 1.0,  r: 139, g: 92,  b: 246 },  // back to violet
    ];

    let lower = stops[0], upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (pos >= stops[i].pos && pos <= stops[i + 1].pos) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }

    const t = upper.pos === lower.pos ? 0 : (pos - lower.pos) / (upper.pos - lower.pos);
    return {
      r: Math.round(lower.r + t * (upper.r - lower.r)),
      g: Math.round(lower.g + t * (upper.g - lower.g)),
      b: Math.round(lower.b + t * (upper.b - lower.b)),
    };
  }

  // Generate energy bar colors from real amplitude data
  function generateEnergyColors(text, ampData) {
    const segmentCount = 40;
    const colors = [];

    if (ampData && ampData.amplitudes.length > 0) {
      const amps = ampData.amplitudes;
      const step = amps.length / segmentCount;
      for (let i = 0; i < segmentCount; i++) {
        const idx = Math.min(Math.floor(i * step), amps.length - 1);
        const v = amps[idx];
        const c = volumeToColor(v);
        colors.push({ r: c.r, g: c.g, b: c.b, a: 0.3 + v * 0.7, height: 0.15 + v * 0.85 });
      }
    } else if (text) {
      const words = text.split(/\s+/);
      for (let i = 0; i < segmentCount; i++) {
        const v = 0.3 + Math.random() * 0.4;
        const c = volumeToColor(v);
        colors.push({ r: c.r, g: c.g, b: c.b, a: 0.4, height: 0.3 + v * 0.5 });
      }
    }
    return colors;
  }

  function renderEnergyBar(container, text, ampData) {
    const existing = container.querySelector(".mst-energy-bar");
    if (existing) existing.remove();

    const colors = generateEnergyColors(text, ampData);
    if (colors.length === 0) return;

    const bar = document.createElement("div");
    bar.className = "mst-energy-bar";

    colors.forEach((c) => {
      const seg = document.createElement("div");
      seg.className = "mst-bar-segment";
      seg.style.background = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
      seg.style.transform = `scaleY(${c.height})`;
      seg.style.boxShadow = `0 2px 4px rgba(${c.r}, ${c.g}, ${c.b}, ${c.a * 0.4})`;
      bar.appendChild(seg);
    });

    container.prepend(bar);
  }

  // Render expressive transcript with volume-based word styling
  function renderVibeBanner(container, vibe) {
    if (!vibe || !vibe.emoji) return;
    const banner = document.createElement("div");
    banner.className = "mst-vibe-banner";

    const emoji = document.createElement("span");
    emoji.className = "mst-vibe-emoji";
    emoji.textContent = vibe.emoji;
    banner.appendChild(emoji);

    const textWrap = document.createElement("div");
    textWrap.className = "mst-vibe-text";

    const label = document.createElement("span");
    label.className = "mst-vibe-label";
    label.textContent = "vibe";
    textWrap.appendChild(label);

    const mood = document.createElement("span");
    mood.className = "mst-vibe-mood";
    mood.textContent = vibe.vibe || "Unknown";
    textWrap.appendChild(mood);

    banner.appendChild(textWrap);

    // Energy dots
    const energyWrap = document.createElement("div");
    energyWrap.className = "mst-vibe-energy";
    const level = vibe.energy === "high" ? 3 : vibe.energy === "medium" ? 2 : 1;
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "mst-vibe-dot" + (i < level ? " active" : "");
      energyWrap.appendChild(dot);
    }
    banner.appendChild(energyWrap);

    container.prepend(banner);
  }

  function renderTranscriptResult(box, text, mood, language, durationText, segments, ampData, vibe, summary) {
    const borderWrap = document.createElement("div");
    borderWrap.className = "mst-border-wrap";
    borderWrap.style.setProperty("--mst-c1", mood.c1);
    borderWrap.style.setProperty("--mst-c2", mood.c2);
    borderWrap.style.setProperty("--mst-c3", mood.c3);
    borderWrap.style.setProperty("--mst-glow", mood.glow);

    const borderInner = document.createElement("div");
    borderInner.className = "mst-border-inner";
    borderInner.style.setProperty("--mst-bg", mood.bg);

    // Header bar
    const header = document.createElement("div");
    header.className = "mst-header";
    header.style.setProperty("--mst-header-color", mood.headerColor);
    header.style.setProperty("--mst-header-bg", mood.headerBg);
    header.style.setProperty("--mst-divider", mood.divider);

    const emojiSpan = document.createElement("span");
    emojiSpan.className = "mst-header-emoji";
    emojiSpan.textContent = mood.emoji;
    header.appendChild(emojiSpan);

    const moodLabel = document.createElement("span");
    moodLabel.textContent = mood.label;
    header.appendChild(moodLabel);

    if (language) {
      const langBadge = document.createElement("span");
      langBadge.className = "mst-header-badge";
      langBadge.style.setProperty("--mst-badge-bg", mood.badgeBg);
      langBadge.style.setProperty("--mst-badge-color", mood.badgeColor);
      langBadge.textContent = language;
      header.appendChild(langBadge);
    }

    if (durationText) {
      const dur = document.createElement("span");
      dur.className = "mst-header-duration";
      dur.textContent = durationText;
      header.appendChild(dur);
    }

    borderInner.appendChild(header);

    // Energy bar with real audio data
    renderEnergyBar(borderInner, text, ampData);

    // Summary section (for long messages)
    if (summary) {
      const summarySection = document.createElement("div");
      summarySection.className = "mst-summary-section";

      const summaryHeader = document.createElement("div");
      summaryHeader.className = "mst-summary-header";
      summaryHeader.textContent = "summary";
      summarySection.appendChild(summaryHeader);

      const summaryText = document.createElement("div");
      summaryText.className = "mst-summary-text" + (summary === "..." ? " mst-loading" : "");
      summaryText.textContent = summary === "..." ? "Summarizing..." : summary;
      summarySection.appendChild(summaryText);

      // Toggle button
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "mst-summary-toggle";
      const arrow = document.createElement("span");
      arrow.className = "mst-toggle-arrow";
      arrow.textContent = "\u25BC";
      toggleBtn.appendChild(arrow);
      const toggleLabel = document.createElement("span");
      toggleLabel.textContent = "Show full transcript";
      toggleBtn.appendChild(toggleLabel);
      summarySection.appendChild(toggleBtn);

      borderInner.appendChild(summarySection);

      // Divider
      const divider = document.createElement("div");
      divider.className = "mst-transcript-divider";
      borderInner.appendChild(divider);
    }

    // Expressive text content
    const textContent = document.createElement("div");
    textContent.className = "mst-text-content";
    textContent.style.setProperty("--mst-quote-color", mood.quoteColor);

    // If summary exists, wrap full transcript in collapsible container
    if (summary) {
      textContent.classList.add("mst-full-transcript");
    }

    const textInner = document.createElement("div");
    textInner.className = "mst-text-inner";

    if (segments && segments.length > 0 && ampData) {
      // Volume-driven word rendering (with emoticons)
      const emotifiedSegments = segments.map(seg => ({
        ...seg,
        text: addEmoticons(seg.text),
      }));
      renderExpressiveWords(textInner, emotifiedSegments, ampData);
    } else {
      // Fallback: plain text with emoticons, clean capitalization, and paragraphs
      const cleaned = cleanTranscriptText(addEmoticons(text));
      const fallbackParas = splitIntoParagraphs(cleaned);
      textInner.innerHTML = fallbackParas.map(p => {
        const escaped = p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<p style="margin:0 0 10px 0;line-height:1.7">${escaped}</p>`;
      }).join("") || '<span style="opacity:0.5">(empty)</span>';
    }

    textContent.appendChild(textInner);
    borderInner.appendChild(textContent);

    // Wire up the toggle button
    if (summary) {
      const toggleBtn = borderInner.querySelector(".mst-summary-toggle");
      const toggleLabel = toggleBtn.querySelector("span:last-child");
      toggleBtn.addEventListener("click", () => {
        const isOpen = textContent.classList.toggle("mst-open");
        toggleBtn.classList.toggle("mst-expanded", isOpen);
        toggleLabel.textContent = isOpen ? "Hide full transcript" : "Show full transcript";
      });
    }
    borderWrap.appendChild(borderInner);

    box.innerHTML = "";
    box.appendChild(borderWrap);

    // Add vibe banner at top if available
    if (vibe) {
      renderVibeBanner(borderInner, vibe);
    }
  }

  // Remove filler words for cleaner, more readable transcripts
  function removeFiller(text) {
    if (!text) return text;
    // Multi-word fillers first (order matters)
    text = text.replace(/\b(you know what I mean)\b/gi, "");
    text = text.replace(/\b(you know what)\b/gi, "");
    text = text.replace(/\b(if that makes sense)\b/gi, "");
    text = text.replace(/\b(or something like that)\b/gi, "");
    text = text.replace(/\b(or something)\b/gi, "");
    text = text.replace(/\b(and stuff like that)\b/gi, "");
    text = text.replace(/\b(and stuff)\b/gi, "");
    text = text.replace(/\b(at the end of the day)\b/gi, "");
    text = text.replace(/\b(I mean)\b/gi, "");
    text = text.replace(/\b(you know)\b/gi, "");
    text = text.replace(/\b(I guess)\b/gi, "");
    text = text.replace(/\b(kind of)\b/gi, "");
    text = text.replace(/\b(sort of)\b/gi, "");
    // Repeated yeah/ok
    text = text.replace(/\b(yeah\s+yeah(\s+yeah)*)\b/gi, "yeah");
    text = text.replace(/\b(ok(ay)?\s+ok(ay)?)\b/gi, "okay");
    text = text.replace(/\b(no\s+no(\s+no)*)\b/gi, "no");
    // Single-word fillers (careful — only obvious ones)
    text = text.replace(/\b(um+|uh+|uhm+|eh+|er+|hmm+)\b/gi, "");
    text = text.replace(/\b(basically)\b/gi, "");
    text = text.replace(/\b(literally)\b/gi, "");
    // Dutch fillers
    text = text.replace(/\b(zeg maar)\b/gi, "");
    text = text.replace(/\b(weet je)\b/gi, "");
    text = text.replace(/\b(snap je)\b/gi, "");
    text = text.replace(/\b(eigenlijk)\b/gi, "");
    text = text.replace(/\b(gewoon)\b/gi, "");
    text = text.replace(/\b(een beetje)\b/gi, "");
    text = text.replace(/\b(ofzo)\b/gi, "");
    text = text.replace(/\b(enzo)\b/gi, "");
    text = text.replace(/\b(ja\s+ja(\s+ja)*)\b/gi, "ja");
    text = text.replace(/\b(nee\s+nee(\s+nee)*)\b/gi, "nee");
    // Clean up leftover double spaces and awkward punctuation
    text = text.replace(/\s{2,}/g, " ");
    text = text.replace(/\s+([.!?,;:])/g, "$1");
    text = text.replace(/([.!?,;:])\s*([.!?,;:])/g, "$1");
    return text.trim();
  }

  // Clean up transcript text: proper sentences, capitalization, punctuation
  function cleanTranscriptText(text) {
    if (!text) return text;
    // Remove filler words first
    text = removeFiller(text);
    // Ensure space after punctuation
    text = text.replace(/([.!?,;:])([A-Za-z])/g, "$1 $2");
    // Capitalize first letter after sentence-ending punctuation
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (m, pre, letter) => pre + letter.toUpperCase());
    // Capitalize first character
    text = text.charAt(0).toUpperCase() + text.slice(1);
    // Capitalize "I" as standalone word
    text = text.replace(/\bi\b/g, "I");
    // Ensure sentence ends with punctuation if it doesn't
    text = text.trim();
    if (text.length > 0 && !/[.!?]$/.test(text)) {
      text += ".";
    }
    return text;
  }

  // Split text into readable chunks — ALWAYS produces multiple short paragraphs
  function splitIntoParagraphs(text) {
    if (!text) return [];

    const allWords = text.split(/\s+/).filter(w => w.length > 0);
    console.log(LOG_PREFIX, "splitIntoParagraphs: total words =", allWords.length, "text preview:", text.substring(0, 100));

    // Short text: keep as one
    if (allWords.length <= 20) {
      let t = text.charAt(0).toUpperCase() + text.slice(1);
      if (!/[.!?]$/.test(t.trim())) t = t.trim() + ".";
      return [t];
    }

    // Strong break words — clearly signal a new thought/topic
    const strongBreakWords = new Set([
      "so", "but", "anyway", "anyways", "actually", "basically",
      "honestly", "okay", "ok", "well", "however", "although",
      "besides", "meanwhile", "anyway",
    ]);

    const paragraphs = [];
    let currentWords = [];

    allWords.forEach((word, i) => {
      currentWords.push(word);
      const count = currentWords.length;

      const nextWord = i + 1 < allWords.length ? allWords[i + 1].toLowerCase().replace(/[,.:;!?]/g, "") : "";
      const nextIsStrongBreak = strongBreakWords.has(nextWord);
      const isLastWord = i === allWords.length - 1;

      // ONLY break after sentence-ending punctuation (.!?) to avoid mid-sentence cuts
      const endsWithSentence = /[.!?]$/.test(word);
      const shouldBreak =
        (!isLastWord) && endsWithSentence && (
          (count >= 30) ||                              // 30+ words + sentence end — ideal break
          (count >= 20 && nextIsStrongBreak)             // 20+ words + sentence end + strong break word
        );
      // Emergency fallback: force break at 50 words even without punctuation
      const forceBreak = (!isLastWord) && (count >= 50);

      if (shouldBreak || forceBreak) {
        let paraText = currentWords.join(" ").trim();
        paraText = paraText.charAt(0).toUpperCase() + paraText.slice(1);
        if (!/[.!?]$/.test(paraText)) paraText += ".";
        paragraphs.push(paraText);
        currentWords = [];
      }
    });

    // Remaining words
    if (currentWords.length > 0) {
      let paraText = currentWords.join(" ").trim();
      paraText = paraText.charAt(0).toUpperCase() + paraText.slice(1);
      if (!/[.!?]$/.test(paraText)) paraText += ".";
      paragraphs.push(paraText);
    }

    console.log(LOG_PREFIX, "splitIntoParagraphs: produced", paragraphs.length, "paragraphs");
    return paragraphs;
  }

  // Flatten segments into individual words with timing + volume info
  function flattenSegmentsToWords(segments, ampData) {
    const words = [];
    segments.forEach((seg) => {
      const segVolume = getVolumeForTimeRange(ampData, seg.start, seg.end);
      const segWords = seg.text.split(/\s+/).filter(w => w.length > 0);
      const segDuration = seg.end - seg.start;

      segWords.forEach((word, wi) => {
        const frac = segWords.length > 1 ? wi / (segWords.length - 1) : 0.5;
        const wordTime = seg.start + frac * segDuration;
        const windowSec = Math.max(segDuration / segWords.length, 0.1);
        const wordVolume = getVolumeForTimeRange(ampData, wordTime - windowSec / 2, wordTime + windowSec / 2);
        words.push({
          text: word,
          volume: segVolume * 0.3 + wordVolume * 0.7,
        });
      });
    });
    return words;
  }

  function renderExpressiveWords(container, segments, ampData) {
    // 1. Build full clean text from all segments
    const rawText = segments.map(s => s.text).join(" ");
    const cleanText = cleanTranscriptText(rawText);

    // 2. Split into short readable paragraphs (works with or without punctuation)
    const paragraphTexts = splitIntoParagraphs(cleanText);
    console.log(LOG_PREFIX, "Rendering", paragraphTexts.length, "paragraphs:", paragraphTexts.map(p => p.substring(0, 40) + "..."));

    // 3. Flatten segments into word-level volume data
    const volumeWords = flattenSegmentsToWords(segments, ampData);

    // 4. Count total words for color gradient
    const totalWords = paragraphTexts.reduce((sum, p) => sum + p.split(/\s+/).filter(w => w).length, 0);
    let globalWordIdx = 0;
    let volumeIdx = 0;

    // Reading speed
    const msPerWord = 160;

    // 5. Render each paragraph
    paragraphTexts.forEach((paraText, paraIdx) => {
      const paraWrap = document.createElement("div");
      paraWrap.className = "mst-segment";

      const words = paraText.split(/\s+/).filter(w => w.length > 0);

      words.forEach((word) => {
        // Get volume from the flattened volume data (best-effort match)
        const vol = volumeIdx < volumeWords.length ? volumeWords[volumeIdx].volume : 0.5;
        volumeIdx++;

        const position = totalWords > 1 ? globalWordIdx / (totalWords - 1) : 0;
        const color = positionToColor(position);
        const style = volumeToStyle(vol);

        const span = document.createElement("span");
        span.className = "mst-word";
        span.textContent = word;
        span.style.fontSize = style.fontSize + "px";
        span.style.fontWeight = style.fontWeight;
        span.style.letterSpacing = style.letterSpacing;
        span.style.setProperty("--mst-word-opacity", style.opacity);
        span.style.color = `rgb(${color.r}, ${color.g}, ${color.b})`;
        span.style.setProperty("--mst-read-delay", (globalWordIdx * msPerWord) + "ms");

        paraWrap.appendChild(span);
        paraWrap.appendChild(document.createTextNode(" "));
        globalWordIdx++;
      });

      container.appendChild(paraWrap);

      // Clear visual space between paragraphs
      if (paraIdx < paragraphTexts.length - 1) {
        const gap = document.createElement("div");
        gap.style.height = "20px";
        gap.style.borderBottom = "1px solid rgba(139, 92, 246, 0.08)";
        container.appendChild(gap);
      }
    });
  }

  // Determine "mood" from text — returns full theme info
  function getMoodInfo(text) {
    const moods = {
      energetic: {
        emoji: "\u{1F525}",
        label: "Energetic",
        color: "#f59e0b",
        c1: "#f59e0b", c2: "#f97316", c3: "#ef4444",
        bg: "linear-gradient(135deg, #fffbf5, #ffffff, #fff9f0)",
        headerBg: "rgba(245, 158, 11, 0.06)",
        headerColor: "#d97706",
        divider: "rgba(245, 158, 11, 0.15)",
        badgeBg: "rgba(245, 158, 11, 0.12)",
        badgeColor: "#b45309",
        quoteColor: "rgba(245, 158, 11, 0.12)",
        glow: "0 4px 20px rgba(245, 158, 11, 0.15), 0 0 40px rgba(249, 115, 22, 0.08)",
      },
      questioning: {
        emoji: "\u{1F914}",
        label: "Curious",
        color: "#06b6d4",
        c1: "#06b6d4", c2: "#0891b2", c3: "#2dd4bf",
        bg: "linear-gradient(135deg, #f5fcff, #ffffff, #f0fbff)",
        headerBg: "rgba(6, 182, 212, 0.06)",
        headerColor: "#0e7490",
        divider: "rgba(6, 182, 212, 0.15)",
        badgeBg: "rgba(6, 182, 212, 0.12)",
        badgeColor: "#0e7490",
        quoteColor: "rgba(6, 182, 212, 0.12)",
        glow: "0 4px 20px rgba(6, 182, 212, 0.15), 0 0 40px rgba(45, 212, 191, 0.08)",
      },
      thoughtful: {
        emoji: "\u{1F4AC}",
        label: "Thoughtful",
        color: "#8b5cf6",
        c1: "#8b5cf6", c2: "#7c3aed", c3: "#6366f1",
        bg: "linear-gradient(135deg, #f9f5ff, #ffffff, #f5f0ff)",
        headerBg: "rgba(139, 92, 246, 0.06)",
        headerColor: "#6d28d9",
        divider: "rgba(139, 92, 246, 0.15)",
        badgeBg: "rgba(139, 92, 246, 0.12)",
        badgeColor: "#6d28d9",
        quoteColor: "rgba(139, 92, 246, 0.12)",
        glow: "0 4px 20px rgba(139, 92, 246, 0.15), 0 0 40px rgba(99, 102, 241, 0.08)",
      },
      brief: {
        emoji: "\u{1F49C}",
        label: "Brief",
        color: "#ec4899",
        c1: "#ec4899", c2: "#f43f5e", c3: "#d946ef",
        bg: "linear-gradient(135deg, #fff5fa, #ffffff, #fff0f7)",
        headerBg: "rgba(236, 72, 153, 0.06)",
        headerColor: "#be185d",
        divider: "rgba(236, 72, 153, 0.15)",
        badgeBg: "rgba(236, 72, 153, 0.12)",
        badgeColor: "#be185d",
        quoteColor: "rgba(236, 72, 153, 0.12)",
        glow: "0 4px 20px rgba(236, 72, 153, 0.15), 0 0 40px rgba(244, 63, 94, 0.08)",
      },
    };

    if (!text) return moods.thoughtful;
    const lower = text.toLowerCase();
    const exclaim = (text.match(/!/g) || []).length;
    const question = (text.match(/\?/g) || []).length;
    const wordCount = text.split(/\s+/).length;
    const avgWordLen = text.replace(/\s+/g, "").length / wordCount;

    if (exclaim > 2 || (text !== lower && text.replace(/[^A-Z]/g, "").length > text.length * 0.3)) {
      return moods.energetic;
    }
    if (question > 1) {
      return moods.questioning;
    }
    if (avgWordLen > 5 && exclaim === 0) {
      return moods.thoughtful;
    }
    if (wordCount < 10) {
      return moods.brief;
    }
    return moods.thoughtful;
  }

  function createMiniWave() {
    const wave = document.createElement("span");
    wave.className = "mst-mini-wave";
    const heights = [4, 8, 5, 10, 6, 9, 4, 7];
    heights.forEach((h, i) => {
      const bar = document.createElement("span");
      bar.className = "mst-mini-bar";
      bar.style.height = h + "px";
      bar.style.animationDelay = (i * 0.1) + "s";
      wave.appendChild(bar);
    });
    return wave;
  }

  function isOwnMessage(row) {
    if (SITE === "whatsapp") {
      // WhatsApp: outgoing messages have class "message-out" or are on the right
      if (row.classList.contains("message-out")) return true;
      if (row.querySelector(".message-out")) return true;
    }
    // Fallback for both sites: check screen position
    const playBtn = row.querySelector('[aria-label="Play"]') || row.querySelector('[aria-label="Pause"]') || row.querySelector('[aria-label="Play voice message"]');
    const target = playBtn || row;
    const rect = target.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const own = center > window.innerWidth / 2;
    return own;
  }

  function addTranscriptButton(row, playBtn) {
    const own = isOwnMessage(row);
    const wrapper = document.createElement("div");
    wrapper.className = "mst-wrapper " + (own ? "mst-own" : "mst-other");

    const btn = document.createElement("button");
    btn.className = "mst-btn";

    const iconSpan = document.createElement("span");
    iconSpan.className = "mst-btn-icon";
    iconSpan.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';

    const labelSpan = document.createElement("span");
    labelSpan.textContent = "Transcript";

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);

    const box = document.createElement("div");
    box.className = "mst-transcript-box";

    let transcribed = false;
    let visible = false;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (transcribed) {
        visible = !visible;
        box.style.display = visible ? "block" : "none";
        labelSpan.textContent = visible ? "Hide" : "Transcript";
        return;
      }

      btn.classList.add("mst-loading");
      labelSpan.textContent = "";

      // Gradient loading text in button
      const loadText = document.createElement("span");
      loadText.className = "mst-loading-text";
      loadText.textContent = "Listening...";
      labelSpan.appendChild(loadText);

      // Add mini waveform to button
      const wave = createMiniWave();
      btn.appendChild(wave);

      box.className = "mst-transcript-box mst-status";
      box.style.display = "block";
      box.innerHTML = '<div class="mst-shimmer"></div><span class="mst-loading-text">Capturing audio...</span>';

      try {
        let audioData = null;

        // Strategy 1: Click Play (silently), capture which blobUrl gets played, pause immediately
        window.__msgTranscriber.lastPlayedUrl = null;
        const currentPlayBtn = row.querySelector('[aria-label="Play"]');
        if (currentPlayBtn) {
          // Mute all audio/video elements to prevent audible playback
          const mediaElements = document.querySelectorAll("audio, video");
          const prevStates = [];
          mediaElements.forEach(el => {
            prevStates.push({ el, muted: el.muted, volume: el.volume });
            el.muted = true;
            el.volume = 0;
          });
          // Flag so intercepted play() also mutes newly created elements
          window.__msgTranscriber._silentCapture = true;
          currentPlayBtn.click();
          await new Promise(r => setTimeout(r, 150));
          const pauseBtn = row.querySelector('[aria-label="Pause"]');
          if (pauseBtn) pauseBtn.click();
          window.__msgTranscriber._silentCapture = false;
          // Restore audio state
          prevStates.forEach(({ el, muted, volume }) => {
            el.muted = muted;
            el.volume = volume;
          });
        }

        const playedUrl = window.__msgTranscriber.lastPlayedUrl;
        if (playedUrl && window.__msgTranscriber.blobMap.has(playedUrl)) {
          audioData = window.__msgTranscriber.blobMap.get(playedUrl);
          console.log(LOG_PREFIX, "Matched via Play click:", playedUrl);
        }

        // Strategy 2: If Play didn't give us a URL, wait for blobs and match by size
        if (!audioData) {
          await new Promise(r => setTimeout(r, 2000));
          audioData = getAudioForRow(row);
          if (audioData) {
            console.log(LOG_PREFIX, "Matched via size:", audioData.size);
          }
        }

        // Strategy 3: Wait longer for new blobs
        if (!audioData) {
          box.innerHTML = '<div class="mst-shimmer"></div><span class="mst-loading-text">Loading audio...</span>';
          await new Promise(r => setTimeout(r, 5000));
          audioData = getAudioForRow(row);
        }

        if (!audioData) throw new Error("No audio data captured");

        audioData._used = true;

        // Analyze audio amplitude + transcribe in parallel
        box.innerHTML = '<div class="mst-shimmer"></div><span class="mst-loading-text">Analyzing voice...</span>';

        const format = audioData.type?.includes("ogg") ? "ogg" : "mp4";
        const base64 = arrayBufferToBase64(audioData.rawBuffer);

        const [ampData, bridgeResult] = await Promise.all([
          analyzeAmplitude(audioData.rawBuffer),
          sendToBridge("mst-transcribe-request", { audio: base64, format: format }),
        ]);

        if (!bridgeResult.success) throw new Error(bridgeResult.error || "Transcription failed");
        const result = bridgeResult;

        const text = result.text || "";
        const language = result.language || null;
        const segments = result.segments || [];
        const vibe = result.vibe || null;
        const mood = getMoodInfo(text);

        // Get duration text from the row
        const durMatch = row.innerText.match(/(\d+:\d+)/);
        const durationText = durMatch ? durMatch[1] : null;

        console.log(LOG_PREFIX, "Segments:", segments.length, "Amplitude:", ampData ? ampData.amplitudes.length + " samples" : "n/a", "Vibe:", vibe);

        box.className = "mst-transcript-box mst-result";

        // Check if long enough for summary (80+ words)
        const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
        const needsSummary = wordCount >= 80;
        console.log(LOG_PREFIX, "Word count:", wordCount, "Needs summary:", needsSummary);

        // Render immediately with placeholder summary if needed
        renderTranscriptResult(box, text, mood, language, durationText, segments, ampData, vibe, needsSummary ? "..." : null);

        // Fetch summary async (doesn't block transcript display)
        if (needsSummary) {
          console.log(LOG_PREFIX, "Fetching summary via bridge...");
          sendToBridge("mst-summarize-request", { text: text, language: language })
            .then(data => {
              if (data.success && data.summary) {
                const summaryEl = box.querySelector(".mst-summary-text");
                if (summaryEl) {
                  summaryEl.classList.remove("mst-loading");
                  summaryEl.textContent = data.summary;
                }
              }
            }).catch(err => {
              console.warn(LOG_PREFIX, "Summary fetch failed:", err);
              const section = box.querySelector(".mst-summary-section");
              if (section) section.remove();
            });
        }

        // Update button
        btn.classList.remove("mst-loading");
        if (wave.parentNode) wave.remove();
        labelSpan.textContent = "Hide";

        // Add mood dot to button
        const dot = document.createElement("span");
        dot.className = "mst-mood";
        dot.style.background = mood.color;
        dot.style.color = mood.color;
        btn.appendChild(dot);

        transcribed = true;
        visible = true;
      } catch (err) {
        box.className = "mst-transcript-box mst-error";
        box.innerHTML = "";
        box.textContent = "Error: " + err.message;
        btn.classList.remove("mst-loading");
        if (wave.parentNode) wave.remove();
        labelSpan.textContent = "Retry";
      }
    }, true);

    wrapper.appendChild(btn);
    wrapper.appendChild(box);

    row.dataset.transcriptAdded = "1";
    if (row.parentNode) {
      row.parentNode.insertBefore(wrapper, row.nextSibling);
    }
  }

  // Add emoticons for affectionate words/phrases and non-speech sounds
  function addEmoticons(text) {
    if (!text) return text;
    console.log("[MSG-Transcriber] Raw text before emoticons:", text);
    // Catch ALL Whisper formats: [tag], (tag), *tag*
    // Laughter
    text = text.replace(/[\[(*]\s*lacht\s*[\])*]/gi, " 😂 ");
    text = text.replace(/[\[(*]\s*laughter\s*[\])*]/gi, " 😂 ");
    text = text.replace(/[\[(*]\s*laughing\s*[\])*]/gi, " 😂 ");
    text = text.replace(/[\[(*]\s*laughs\s*[\])*]/gi, " 😂 ");
    text = text.replace(/[\[(*]\s*laugh\s*[\])*]/gi, " 😂 ");
    text = text.replace(/[\[(*]\s*gelach\s*[\])*]/gi, " 😂 ");
    // Giggles
    text = text.replace(/[\[(*]\s*giechelt?\s*[\])*]/gi, " 🤭 ");
    text = text.replace(/[\[(*]\s*giggles?\s*[\])*]/gi, " 🤭 ");
    text = text.replace(/[\[(*]\s*giggling\s*[\])*]/gi, " 🤭 ");
    // Kiss
    text = text.replace(/[\[(*]\s*kus(je)?\s*[\])*]/gi, " 💋 ");
    text = text.replace(/[\[(*]\s*kiss(es)?\s*[\])*]/gi, " 💋 ");
    text = text.replace(/[\[(*]\s*kissing\s*[\])*]/gi, " 💋 ");
    // Sigh
    text = text.replace(/[\[(*]\s*zucht\s*[\])*]/gi, " 😮‍💨 ");
    text = text.replace(/[\[(*]\s*sighs?\s*[\])*]/gi, " 😮‍💨 ");
    text = text.replace(/[\[(*]\s*sighing\s*[\])*]/gi, " 😮‍💨 ");
    // Crying
    text = text.replace(/[\[(*]\s*huilt\s*[\])*]/gi, " 😢 ");
    text = text.replace(/[\[(*]\s*crying\s*[\])*]/gi, " 😢 ");
    text = text.replace(/[\[(*]\s*cries\s*[\])*]/gi, " 😢 ");
    text = text.replace(/[\[(*]\s*snikt?\s*[\])*]/gi, " 😢 ");
    // Applause & music
    text = text.replace(/[\[(*]\s*applause\s*[\])*]/gi, " 👏 ");
    text = text.replace(/[\[(*]\s*applaus\s*[\])*]/gi, " 👏 ");
    text = text.replace(/[\[(*]\s*music\s*[\])*]/gi, " 🎵 ");
    text = text.replace(/[\[(*]\s*muziek\s*[\])*]/gi, " 🎵 ");
    // Spoken laughter: "haha", "hahaha", "hihi", "ha ha ha" etc.
    text = text.replace(/\b(ha\s*ha(\s*ha)*)\b/gi, " 😂 ");
    text = text.replace(/\b(he\s*he(\s*he)*)\b/gi, " 😂 ");
    text = text.replace(/\b(hi\s*hi(\s*hi)*)\b/gi, " 🤭 ");
    text = text.replace(/\b(hahaha+)\b/gi, " 😂 ");
    text = text.replace(/\b(lol)\b/gi, " 😂 ");
    // "muah" / "mwah" / kiss sounds
    text = text.replace(/\b(m+[wu]a+h+)\b/gi, " 💋 ");
    text = text.replace(/\b(kusje)\b/gi, " 💋 ");
    text = text.replace(/\b(kusjes)\b/gi, " 💋 ");
    // Affectionate phrases
    text = text.replace(/\b(i\s+love\s+you)\b/gi, "$1 ❤️");
    text = text.replace(/\b(ik\s+hou\s+van\s+je)\b/gi, "$1 ❤️");
    text = text.replace(/\b(ik\s+hou\s+van\s+jou)\b/gi, "$1 ❤️");
    text = text.replace(/\b(my\s+love)\b/gi, "$1 ❤️");
    text = text.replace(/\b(love\s+you)\b/gi, "$1 ❤️");
    text = text.replace(/\b(schatje)\b/gi, "$1 ❤️");
    text = text.replace(/\b(lieverd)\b/gi, "$1 ❤️");
    // Excitement
    text = text.replace(/\b(oh\s+my\s+god)\b/gi, "$1 😱");
    text = text.replace(/\b(omg)\b/gi, "$1 😱");
    text = text.replace(/\b(wow+)\b/gi, "$1 😮");
    // Clean up double/triple spaces and emoji spacing
    text = text.replace(/\s{2,}/g, " ");
    console.log("[MSG-Transcriber] After emoticons:", text);
    return text;
  }

  function formatTranscript(text) {
    if (!text) return "";
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const parts = escaped.split(/(?<=[.!?])\s+/);
    let result = "";
    for (let i = 0; i < parts.length; i++) {
      result += parts[i].trim();
      if (i < parts.length - 1) {
        result += " ";
        if ((i + 1) % 2 === 0) {
          result += "<br><br>";
        }
      }
    }
    return result;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  waitForDOM();
})();
