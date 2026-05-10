# Changelog

All notable changes to CousinsWatch PRO are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-10

First public release. Cleaned, refactored, and hardened from the internal v13
codebase for public GitHub publication.

### Added

- **`lib/config.js`** — user-editable configuration. Contributors must set
  their own Firebase Realtime Database URL before the extension will function.
  Clear inline guidance and a runtime warning if the placeholder is detected.
- **`lib/network.js`** — proper connectivity diagnostics combining
  `navigator.onLine`, an active probe of the configured Firebase backend, and
  ICE-state observations. Replaces the v13 blind 22-second toast.
- **`lib/pip.js`** — single state-machine for Document Picture-in-Picture and
  the in-extension floating cam. All listeners are scoped to AbortControllers,
  deferred polls carry an epoch counter for cancellation, and stream
  ownership is tracked centrally so the same MediaStream is never attached to
  multiple `<video>` elements simultaneously.
- **`lib/media.js`** — extracted media-acquisition lifecycle.
- **`lib/audio-mixer.js`** — extracted audio mixer with deterministic
  release of all Web Audio nodes on stop.
- **`lib/logger.js`** — levelled logger; replaces ad-hoc `console.log` spam.
- Sender validation in `background.js` for `chrome.runtime.onMessage`.
- ICE candidate validation in `lib/peer.js` (basic injection guard).
- Data channel message validation: type-allowlist + size cap.
- Firebase path validation: rejects path traversal / unsafe characters.
- Cryptographically random Room ID generator (64 bits) replaces v13's
  6-character `Math.random()` ID.
- README with full setup instructions, Firebase configuration, troubleshooting,
  and self-hosted TURN guide.

### Changed

- **Manifest** — `permissions` reduced to `['activeTab']`; `host_permissions`
  set to `[]`; `web_accessible_resources` removed entirely; CSP tightened
  with explicit `default-src`, `frame-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'none'`.
- Project structure split into `lib/` for clean module boundaries; `popup.js`
  reduced from 1167 LOC to ~600 LOC of UI-coordination only.
- All `innerHTML` writes replaced with `createElement` + `textContent` /
  `appendChild` patterns.
- Stream re-assignment guard: `srcObject` is only set if the new stream
  differs from the current one (prevents redundant re-decode flashes).

### Fixed

- **PiP / floating cam degradation after repeated open/close cycles.** Root
  cause: scattered state, leaked closures in `pagehide` listeners, and lack
  of cancellation tokens for deferred polls. Fixed by the new `lib/pip.js`
  state machine.
- **False "Check your internet connection" toast.** Root cause: a blind 22s
  timer fired regardless of whether the network was actually unhealthy. Fixed
  by gating the toast on a real `network.diagnose()` result.
- Audio mixer state accumulation across repeated screen-share cycles. Mixer
  now releases the AudioContext on every stop.

### Security

- See `README.md → Security` section. The extension's signaling channel
  (Firebase) is not authenticated by default and requires the user to apply
  the recommended Realtime Database security rules. A safety-code / DTLS
  fingerprint UI is on the roadmap.
