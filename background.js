/**
 * Voice Memo Transcriber — Background Service Worker
 * Calls Groq API directly (no local server needed).
 */

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const WHISPER_PROMPT = "[laughs] Haha, that's funny! [laughs] Hahaha! [giggles] Hehe. [kiss] Mwah, bye sweetie. [sigh] [crying] I miss you. [laughs] Ha ha ha, too funny! [laughter] That's hilarious! [laughs] Oh my god. [giggles] [sigh] [crying] [applause] [music]";

async function getApiKey() {
  const data = await chrome.storage.local.get("groqApiKey");
  return data.groqApiKey || null;
}

// ---------- Transcription ----------

async function transcribeAudio(base64Audio, format) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No Groq API key set. Click the extension icon to add your key.");

  // Convert base64 to Blob
  const binaryStr = atob(base64Audio);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const mimeType = format === "ogg" ? "audio/ogg" : "audio/mp4";
  const blob = new Blob([bytes], { type: mimeType });

  const formData = new FormData();
  formData.append("file", blob, `audio.${format}`);
  formData.append("model", "whisper-large-v3");
  formData.append("response_format", "verbose_json");
  formData.append("prompt", WHISPER_PROMPT);

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(GROQ_TRANSCRIBE_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData,
      });

      if (response.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        console.log(`[MST-BG] Rate limited, waiting ${wait}ms (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API error ${response.status}: ${errText}`);
      }

      const result = await response.json();

      // Extract segments
      const segments = (result.segments || []).map(seg => ({
        text: (seg.text || "").trim(),
        start: seg.start || 0,
        end: seg.end || 0,
      }));

      const text = (result.text || "").trim();
      const language = result.language || "unknown";

      // Detect vibe via LLM (non-blocking, we'll include it if it's fast)
      let vibe = null;
      try {
        vibe = await detectVibe(apiKey, text, language);
      } catch (e) {
        console.warn("[MST-BG] Vibe detection failed:", e.message);
      }

      return { text, language, duration: result.duration || 0, segments, vibe };

    } catch (e) {
      lastError = e;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }
  }

  throw new Error(`Transcription failed after 3 attempts: ${lastError?.message}`);
}

// ---------- Vibe Detection ----------

async function detectVibe(apiKey, text, language) {
  if (!text || text.trim().length < 5) return null;

  const langHint = language === "nl" ? "Dutch" : language === "en" ? "English" : "the detected language";

  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      max_tokens: 100,
      messages: [
        {
          role: "system",
          content: `You analyze the emotional vibe of voice message transcripts. Respond with EXACTLY one JSON object, nothing else.
Format: {"emoji": "<1-3 emoji>", "vibe": "<2-4 word vibe description>", "energy": "<low/medium/high>"}

Examples:
- Excited happy talk → {"emoji": "😄✨", "vibe": "Happy & excited", "energy": "high"}
- Laughing, joking → {"emoji": "😂🤣", "vibe": "Laughing & playful", "energy": "high"}
- Calm story telling → {"emoji": "😊", "vibe": "Relaxed & chill", "energy": "medium"}
- Sad or emotional → {"emoji": "😢", "vibe": "Sad & emotional", "energy": "low"}
- Angry or frustrated → {"emoji": "😤", "vibe": "Frustrated", "energy": "high"}
- Loving, sweet → {"emoji": "🥰❤️", "vibe": "Sweet & loving", "energy": "medium"}
- Gossip/tea → {"emoji": "👀🍵", "vibe": "Juicy gossip", "energy": "high"}
- Surprised/shocked → {"emoji": "😱", "vibe": "Shook", "energy": "high"}

ALWAYS write the vibe label in English. Be creative with the emoji.
The transcript is in ${langHint}.`,
        },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) return null;

  const result = await response.json();
  let vibeRaw = result.choices[0].message.content.trim();
  if (vibeRaw.startsWith("```")) {
    vibeRaw = vibeRaw.split("\n", 2)[1] || vibeRaw;
    vibeRaw = vibeRaw.replace(/```/g, "").trim();
  }
  return JSON.parse(vibeRaw);
}

// ---------- Summary ----------

async function generateSummary(apiKey, text, language) {
  const langHint = language === "nl" ? "Dutch" : language === "en" ? "English" : "the detected language";

  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You summarize voice message transcripts to their bare essentials. Rules:
- Maximum 2 short sentences
- Keep the same language as the original message
- Only the core point — skip all details, anecdotes, and filler
- Be extremely concise, like a text message
The transcript is in ${langHint}.`,
        },
        { role: "user", content: `Summarize this voice message:\n\n${text}` },
      ],
    }),
  });

  if (!response.ok) return null;

  const result = await response.json();
  let summary = result.choices[0].message.content.trim();
  if (summary.startsWith("```")) {
    summary = summary.split("\n", 2)[1] || summary;
    summary = summary.replace(/```/g, "").trim();
  }
  return summary;
}

// ---------- Message Handler ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "mst-transcribe") {
    transcribeAudio(msg.audio, msg.format)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === "mst-summarize") {
    getApiKey().then(apiKey => {
      if (!apiKey) {
        sendResponse({ success: false, error: "No API key" });
        return;
      }
      return generateSummary(apiKey, msg.text, msg.language);
    })
      .then(summary => sendResponse({ success: true, summary }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === "mst-check-key") {
    getApiKey().then(key => sendResponse({ hasKey: !!key }));
    return true;
  }
});

console.log("[MST-BG] Voice Memo Transcriber background service worker loaded");
