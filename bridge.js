/**
 * Bridge script (ISOLATED world) — connects interceptor.js (MAIN world) to background.js (service worker).
 * MAIN world can't use chrome.runtime, so this script acts as the middleman.
 */

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;

  // --- Transcription request ---
  if (event.data?.type === "mst-transcribe-request") {
    const { id, audio, format } = event.data;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "mst-transcribe",
        audio,
        format,
      });
      window.postMessage({ type: "mst-transcribe-response", id, ...response }, "*");
    } catch (err) {
      window.postMessage({ type: "mst-transcribe-response", id, success: false, error: err.message }, "*");
    }
  }

  // --- Summary request ---
  if (event.data?.type === "mst-summarize-request") {
    const { id, text, language } = event.data;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "mst-summarize",
        text,
        language,
      });
      window.postMessage({ type: "mst-summarize-response", id, ...response }, "*");
    } catch (err) {
      window.postMessage({ type: "mst-summarize-response", id, success: false, error: err.message }, "*");
    }
  }

  // --- API key check ---
  if (event.data?.type === "mst-check-key-request") {
    try {
      const response = await chrome.runtime.sendMessage({ type: "mst-check-key" });
      window.postMessage({ type: "mst-check-key-response", ...response }, "*");
    } catch (err) {
      window.postMessage({ type: "mst-check-key-response", hasKey: false }, "*");
    }
  }
});

console.log("[MsgTranscriber] Bridge script loaded (ISOLATED world)");
