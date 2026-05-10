# CousinsWatch PRO

> Private 1:1 video calling and screen sharing as a Chrome extension.

CousinsWatch PRO is a self-hosted video-calling extension built for staying in touch with one specific person — a cousin, sibling, partner, or close friend. It runs entirely between two browsers using WebRTC, with Firebase Realtime Database used only as a thin signaling channel to exchange connection metadata. Once the call is established, all audio and video flows directly peer-to-peer (or via a TURN relay if necessary).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](#)

---

## Features

- 📹 **Video + audio calls** — webcam + mic, end-to-end encrypted via DTLS-SRTP
- 🖥️ **Screen sharing** with system audio capture and adaptive bitrate
- 🪟 **Document Picture-in-Picture** — pop the cousin's face out into a floating window while you screen-share, with a draggable in-extension fallback if PiP is unavailable
- 🎚️ **Adaptive bitrate** based on the browser's own bandwidth estimator
- 🔐 **Hardware-accelerated H.264** encoding (low CPU even on long sessions)
- 🎙️ **Audio mixer** so screen audio and your voice both go through cleanly
- 🌐 Works behind most NATs (STUN + TURN included)

---

## Quick Start

```text
1. Clone this repo
2. Set up a free Firebase project    (5 min — instructions below)
3. Edit lib/config.js with your URL
4. Load the extension in Chrome
5. Click the extension icon → start your first call
```

---

## Installation

### Prerequisites

- **Chrome 116+** (or any Chromium-based browser with Manifest V3 support — Edge, Brave, Arc, etc.)
- A camera and microphone (or a microphone-only setup)
- A free Firebase account

### 1. Get the code

```bash
git clone https://github.com/<your-username>/CousinsWatch-PRO.git
cd CousinsWatch-PRO
```

Or download the latest release ZIP and extract it.

### 2. Configure Firebase (required — see next section)

You **must** edit `lib/config.js` and replace the placeholder Firebase URL with your own. The extension will not work until you do.

### 3. Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `CousinsWatch-PRO/` folder
5. The extension icon appears in your toolbar — pin it for easy access

### 4. (Optional) Both cousins must use the same Firebase project

Both you and your cousin need to install the extension and edit `lib/config.js` to point at the **same** Firebase URL. If you set up a project together, share the same `firebaseDatabaseUrl` with each other.

---

## Firebase Configuration

CousinsWatch uses Firebase Realtime Database purely as a tiny relay for WebRTC signaling messages (offer, answer, ICE candidates). No video, audio, or chat content ever touches Firebase.

### Step 1: Create a Firebase project

1. Go to <https://console.firebase.google.com>
2. Click **Add project** → give it any name (e.g. `cousinswatch-yourname`)
3. Disable Google Analytics (optional, not needed)
4. Click **Create project**

### Step 2: Set up Realtime Database

1. In the left sidebar, click **Build → Realtime Database**
2. Click **Create Database**
3. Choose a location (any region close to you and your cousin)
4. Pick **Start in test mode** for initial setup *(see security note below)*
5. Click **Enable**

### Step 3: Copy your database URL

At the top of the Data tab you'll see something like:

```
https://cousinswatch-yourname-default-rtdb.firebaseio.com
```

or for non-US regions:

```
https://cousinswatch-yourname-default-rtdb.europe-west1.firebasedatabase.app
```

### Step 4: Paste it into `lib/config.js`

Open `lib/config.js` in any editor and replace the placeholder line:

```js
firebaseDatabaseUrl: 'https://YOUR-PROJECT-default-rtdb.firebaseio.com',
```

with **your** URL from the previous step. Save the file.

### Step 5: Reload the extension

In `chrome://extensions`, click the refresh icon on the CousinsWatch row. Otherwise the new config file isn't picked up.

### ⚠️ Security: Lock down your database before regular use

"Test mode" leaves your database open to the world for 30 days. For long-term use, edit your security rules:

In Firebase console → Realtime Database → **Rules** tab, replace with:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read":  "$roomId.matches(/^CW-[A-Z0-9]+$/)",
        ".write": "$roomId.matches(/^CW-[A-Z0-9]+$/) && newData.hasChildren()"
      }
    }
  }
}
```

For maximum security, also require Firebase Authentication. See the [Firebase docs on rules](https://firebase.google.com/docs/database/security/rules-conditions) for the full guide.

---

## Usage

### Hosting a call

1. Click the extension icon — the popup opens
2. Allow camera and microphone access on first launch
3. Leave the Room ID field blank
4. Click **🔗 Connect**
5. A Room ID appears (e.g. `CW-ABC123XYZ`) — click **📋 Copy** and send it to your cousin
6. Wait — once they join, the call connects automatically

### Joining a call

1. Click the extension icon
2. Paste the Room ID your cousin sent you
3. Click **🔗 Connect**

### During a call

| Button | What it does |
|---|---|
| 📷 / 🚫 | Toggle camera |
| 🎙️ / 🔇 | Toggle microphone |
| 🖥️ | Start / stop screen share (with system audio) |
| 📵 | Hang up but stay in the room |
| Leave | Disconnect entirely |

### Screen sharing tips

- Tick **"Share tab audio"** in the screen-picker dialog to capture system audio
- Cousin's face will pop out into a Picture-in-Picture window so they're visible while you share
- If PiP isn't supported by your browser, a draggable floating-cam appears inside the extension instead
- The PiP / floating cam can be popped out at any time via the **⤢ Pop out** button

---

## Architecture

```
┌──────────────────┐                        ┌──────────────────┐
│   Your browser   │                        │ Cousin's browser │
│                  │                        │                  │
│   popup.js       │                        │   popup.js       │
│      │           │                        │      │           │
│   signaling.js   │                        │   signaling.js   │
│      │           │                        │      │           │
│   peer.js ──────┐│                        │┌────── peer.js   │
│                 ││                        ││                 │
│   webrtc.js     ││                        ││     webrtc.js   │
│      │          ││                        ││         │       │
│   pip.js        ││  ┌────────────────────┐││      pip.js     │
│   media.js      │└─►│ Firebase Realtime  │◄┘│   media.js     │
│   audio-mixer.js│   │   (signaling only) │  │   audio-mixer.js│
│                 │   └────────────────────┘  │                 │
│      │          │                           │      │          │
│      └──────────────── WebRTC P2P ───────────────────┘        │
│              (audio/video direct or via TURN)                 │
└───────────────────────────────────────────────────────────────┘
```

### Module map

| File | Responsibility |
|---|---|
| `manifest.json`        | MV3 declaration; permissions kept minimal |
| `background.js`        | Popup window lifecycle; sender-validated message handler |
| `popup.html`           | UI structure and styling |
| `popup.js`             | UI coordinator — wires modules to DOM events |
| `lib/config.js`        | **User-editable** configuration (Firebase URL, ICE servers) |
| `lib/logger.js`        | Levelled logger |
| `lib/network.js`       | Real connectivity diagnostics (replaces v9's blind 22s timer) |
| `lib/peer.js`          | Custom Peer over Firebase signaling, with input validation |
| `lib/signaling.js`     | Peer wrapper exposing onCall / onConnection / onData |
| `lib/webrtc.js`        | Codec preferences, screen-share lifecycle, adaptive bitrate |
| `lib/media.js`         | getUserMedia / getDisplayMedia lifecycle |
| `lib/pip.js`           | Document PiP + floating cam state machine (single source of truth) |
| `lib/audio-mixer.js`   | Mic + screen audio Web Audio mixing |

---

## Troubleshooting

### "Firebase not configured" toast on launch

You haven't edited `lib/config.js` yet. See [Firebase Configuration](#firebase-configuration) above.

### "Could not reach the signaling server"

- Check your internet connection
- Verify your `firebaseDatabaseUrl` in `lib/config.js` is correct (no trailing slash, no quotes inside the URL)
- Open DevTools (right-click extension popup → Inspect) → Console — look for fetch errors with the actual URL
- In the Firebase console, confirm the database is in the **Realtime Database** product (not Firestore — they're different)

### "Could not reach that room — check the ID"

- The Room ID is case-sensitive in display but the extension uppercases it on input. If still failing, ask your cousin to paste it fresh
- The host may have closed their popup — Room IDs only exist while the host is online
- Confirm both of you are using the **same Firebase project URL**

### Camera or microphone permission denied

- Click the camera icon in Chrome's address bar to re-grant permission
- On macOS: System Settings → Privacy & Security → Camera/Microphone — make sure Chrome is allowed
- On Linux: Some Wayland setups don't expose webcams to Chrome — try logging into an X11 session

### Picture-in-Picture window is laggy or won't open

- Document PiP requires Chrome 116+. Check `chrome://version`.
- Some Chromium derivatives (older Brave, older Arc) don't expose `documentPictureInPicture` yet. The extension falls back to an in-extension floating cam — which is draggable and works just as well.

### Screen share has no audio

- Tick the **"Share tab audio"** checkbox in the screen picker
- On macOS, system-wide audio capture is restricted; you may need to share a single tab or window with audio rather than the whole screen

### Repeated screen-share cycles cause flickering / black PiP

This was a known issue in pre-1.0 versions and is **fixed in v1.0** by a centralised PiP state machine (`lib/pip.js`). If you still see it on v1.0, please [open an issue](#) with browser version and reproduction steps.

### Connection works locally but not over the internet

About 15% of network configurations require a TURN server (especially symmetric NATs and some corporate networks). The included OpenRelay TURN credentials are a free public service — they sometimes get rate-limited. For reliability, [run your own coturn server](#self-hosted-turn-recommended-for-production) (~$5/month VPS).

---

## Security

This is a personal project for keeping in touch with someone you trust. It's not a hardened messaging product — please don't use it for highly sensitive conversations without understanding the trade-offs.

What is good:
- Audio/video are end-to-end encrypted via WebRTC's DTLS-SRTP
- No call content goes through Firebase or any other server
- The extension declares minimal permissions (`activeTab` only) and an empty `host_permissions` list

What is **NOT** end-to-end secure by default:
- Firebase signaling is not authenticated by default — anyone who knows your Firebase URL can read/write Room IDs. Lock it down with Firebase Security Rules ([see above](#-security-lock-down-your-database-before-regular-use))
- DTLS fingerprints are exchanged over the (potentially public) Firebase channel. There's no in-app safety-code / fingerprint comparison, so a sophisticated active attacker who controlled Firebase could in theory MITM the call. Adding a safety code is on the roadmap.

For threat modeling and per-finding analysis, see [`SECURITY.md`](SECURITY.md) (separate document).

### Self-hosted TURN (recommended for production)

The default `lib/config.js` uses OpenRelay's public TURN service for free relay when peers can't reach each other directly. It works but has no SLA and the credentials are well-known.

For private long-term use, run your own coturn:

```bash
# On a small Linux VPS (Hetzner, OVH, Vultr — ~$5/month is plenty)
sudo apt install coturn
# Edit /etc/turnserver.conf with your domain + a long random secret
sudo systemctl enable --now coturn
```

Then replace the `turn:` entries in `lib/config.js` with your own server. See the [coturn wiki](https://github.com/coturn/coturn/wiki) for full setup.

---

## Development

### Project layout

```
CousinsWatch-PRO/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── lib/
│   ├── config.js          ← USER EDITS THIS
│   ├── logger.js
│   ├── network.js
│   ├── peer.js
│   ├── signaling.js
│   ├── webrtc.js
│   ├── media.js
│   ├── pip.js
│   └── audio-mixer.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
├── CHANGELOG.md
└── LICENSE
```

### Running with hot-reload

There's no build step — every file is plain JS / HTML. After editing:

1. Save the file
2. Go to `chrome://extensions`
3. Click the refresh icon on the CousinsWatch card
4. Re-open the extension popup

### Debugging

- **Popup**: right-click the extension popup → Inspect
- **Background service worker**: `chrome://extensions` → click "service worker" link under CousinsWatch
- **WebRTC stats**: open `chrome://webrtc-internals` while a call is in progress — full SDP, stats, ICE candidates

### Adjusting log verbosity

Edit `lib/config.js`:

```js
logLevel: 'debug',   // 'debug' | 'info' | 'warn' | 'error' | 'silent'
```

---

## Roadmap

- [ ] In-call text chat (over the existing data channel)
- [ ] DTLS fingerprint safety-code UI (Signal-style)
- [ ] Cryptographically random Room IDs (currently 64-bit random hex)
- [ ] File transfer over data channel
- [ ] Multi-device call history (optional, encrypted at rest)

Contributions welcome — open an issue first to discuss.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

Built by cousins, for cousins. STUN/TURN servers courtesy of [Google](https://developers.google.com/talk/libjingle/relay_server) and [OpenRelay (Metered)](https://www.metered.ca/tools/openrelay/). Adaptive-bitrate logic inspired by Chrome's GCC implementation.
