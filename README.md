# Voice Memo Transcriber

A Chrome extension that automatically transcribes voice memos on **WhatsApp Web** and **Facebook Messenger** using Groq's Whisper API.

**No server needed** — just install the extension, enter your free Groq API key, and you're good to go.

## Features

- **One-click transcription** — adds a "Transcript" button next to every voice message
- **Works on both sites** — WhatsApp Web and Facebook Messenger
- **Vibe detection** — AI-powered mood analysis with emoji indicators
- **Energy bars** — visual energy level display for each message
- **Volume-styled text** — whispered words appear small, loud words appear bold
- **Smart filler removal** — cleans up "um", "uh", "like" and other fillers
- **Summary mode** — get a TL;DR of long voice messages
- **Fully serverless** — runs entirely in your browser, no backend needed

## Installation

1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select this folder
5. Click the extension icon and enter your Groq API key
6. Open [WhatsApp Web](https://web.whatsapp.com) or [Messenger](https://www.messenger.com)
7. Voice messages now have a **Transcript** button!

## Getting a Groq API Key

1. Go to [console.groq.com](https://console.groq.com/keys)
2. Create a free account
3. Generate an API key
4. Paste it into the extension popup

Groq offers a generous free tier — more than enough for personal use.

## How It Works

```
interceptor.js (MAIN world) — captures audio + renders UI
  → window.postMessage
    → bridge.js (ISOLATED world) — bridges worlds
      → chrome.runtime.sendMessage
        → background.js (service worker)
          → Groq Whisper API (transcription)
          → Groq Llama 3.3 70b (vibe + summary)
```

The extension intercepts audio playback APIs to capture voice message data, then sends it to Groq's cloud API for transcription. No audio data is stored — everything is processed in real-time.

## Tech Stack

- **Chrome Extension Manifest V3**
- **Groq Whisper large-v3** for speech-to-text
- **Groq Llama 3.3 70b** for vibe detection and summarization
- Vanilla JavaScript, no dependencies

## Privacy

- Your API key is stored locally in Chrome's storage
- Audio is sent to Groq's API for transcription only
- No data is collected, stored, or sent anywhere else
- No analytics, no tracking, no server

## License

MIT
