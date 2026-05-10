// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — PiP Manager
//
// Single source of truth for the floating camera + Document Picture-in-Picture
// state, replacing the scattered _pipWindow / _pipVideoEl / _pendingViewerPipStream
// / _showFloatingCam / hideFallbackPip mess from v13.
//
// ── Why this rewrite was needed ──
// In v13, repeatedly opening and closing the PiP / floating cam over a long
// session degrades reliability because:
//   1. Each open creates a new <video> element and new event listeners but
//      old references leak through closures (deferred polls, pagehide handlers).
//   2. A single MediaStream object gets attached to multiple <video> elements
//      simultaneously without coordination.
//   3. Deferred polling functions (showSharerPipDeferred etc.) have no
//      cancellation, so old polls fire after newer state has taken over.
//   4. `_pendingViewerPipStream` is mutated globally — race conditions.
//   5. `srcObject = null` on hide is inconsistent — sometimes the element
//      keeps a ref to a stale stream, holding it alive in memory.
//
// ── This module enforces ──
//   • One PiP target (Document PiP window OR in-extension floating cam) at a
//     time, with explicit transitions between them.
//   • Stream attached to ONLY ONE <video> element at a time. The stream is
//     released cleanly on every state change.
//   • Cancellation tokens for any deferred attach attempts.
//   • Idempotent open/close: calling close() when already closed is a no-op.
//   • All event listeners registered with AbortController so old listeners
//     are guaranteed to be released on transition.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('pip');

  /**
   * PiP slot states:
   *   IDLE      → nothing shown
   *   FLOATING  → in-extension <div id="floatingCam"> visible
   *   DOCPIP    → external Document Picture-in-Picture window open
   */
  const State = Object.freeze({
    IDLE: 'idle',
    FLOATING: 'floating',
    DOCPIP: 'docpip',
  });

  class PipManager {
    constructor() {
      this._state = State.IDLE;
      this._currentStream = null;

      // Document PiP
      this._pipWindow = null;
      this._pipVideoEl = null;
      this._pipAbort = null;          // AbortController for current PiP listeners

      // Floating cam (in-extension)
      this._floatingCamEl = null;     // <div id="floatingCam">
      this._floatingCamVideoEl = null;// <video id="floatingCamVideo">

      // Cancellation token for deferred stream-attach polls.
      // Bumped on every state change; old polls compare against this and bail.
      this._epoch = 0;
    }

    /** Wire DOM references and one-time popout button binding. */
    init({ floatingCamEl, floatingCamVideoEl, popoutButtonEl }) {
      this._floatingCamEl = floatingCamEl || null;
      this._floatingCamVideoEl = floatingCamVideoEl || null;

      if (popoutButtonEl) {
        // Use AbortController scoped to the lifetime of the manager
        this._popoutAbort = new AbortController();
        popoutButtonEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this._popOutToDocPipFromButton();
        }, { signal: this._popoutAbort.signal });
      }
    }

    get state() { return this._state; }
    get isShowing() { return this._state !== State.IDLE; }
    get hasDocPip() { return this._state === State.DOCPIP; }

    /**
     * Show a stream in the floating cam. If a Document PiP window is open,
     * it's left as-is (caller decides). Returns the new epoch.
     */
    showFloating(stream) {
      if (!this._floatingCamEl || !this._floatingCamVideoEl) {
        log.warn('showFloating: floating cam DOM not initialised');
        return this._epoch;
      }
      if (!stream) {
        log.warn('showFloating: no stream provided');
        return this._epoch;
      }

      // If we already have docpip open, prefer it — but mirror the stream
      // so when docpip closes, the floating cam can take over with no gap.
      if (this._state === State.DOCPIP) {
        this._setStreamOnPipWindow(stream);
        this._currentStream = stream;
        return ++this._epoch;
      }

      const epoch = ++this._epoch;
      this._state = State.FLOATING;
      this._setStreamOnFloatingCam(stream);
      this._currentStream = stream;

      // Default position if not yet styled
      const fc = this._floatingCamEl;
      if (!fc.style.left) {
        fc.style.left   = '14px';
        fc.style.bottom = '14px';
        fc.style.right  = '';
        fc.style.top    = '';
        fc.style.width  = '140px';
        fc.style.height = '96px';
      }
      fc.style.display = 'block';
      log.debug('FLOATING shown, epoch=', epoch);
      return epoch;
    }

    /**
     * Open Document PiP showing the given stream. Must be called from within a
     * user gesture. If the API is unavailable, falls back to floating cam and
     * returns false.
     *
     * Optional: pass {stream: null} to pre-open inside a user gesture before the
     * stream is ready — the stream can be supplied later via setStream().
     */
    async openDocPip({ width = 320, height = 240, stream = null } = {}) {
      if (!('documentPictureInPicture' in window)) {
        log.info('Document PiP not supported');
        if (stream) this.showFloating(stream);
        return false;
      }

      // Close any existing PiP cleanly first to avoid leaks.
      this._closeDocPipQuietly();

      const epoch = ++this._epoch;
      try {
        this._pipWindow = await documentPictureInPicture.requestWindow({
          width,
          height,
          disallowReturnToOpener: true,
          preferInitialWindowPlacement: true,
        });
      } catch (err) {
        log.warn('Document PiP requestWindow failed:', err?.message || err);
        if (stream) this.showFloating(stream);
        return false;
      }

      // Build the PiP DOM. Use textContent / explicit createElement — never
      // innerHTML — because the popup runs with extension privileges.
      const doc = this._pipWindow.document;
      const style = doc.createElement('style');
      style.textContent =
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'html,body{width:100vw;height:100vh;background:#000;overflow:hidden}' +
        '#faceVideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}';
      doc.head.appendChild(style);

      const v = doc.createElement('video');
      v.id = 'faceVideo';
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true;
      doc.body.appendChild(v);

      this._pipVideoEl = v;

      // Listeners scoped to an AbortController so they're guaranteed to be
      // detached when we close — eliminates the v13 leak source.
      this._pipAbort = new AbortController();
      const { signal } = this._pipAbort;

      this._pipWindow.addEventListener('pagehide', () => {
        this._handlePipClosed(epoch);
      }, { signal });

      // Attach the stream if provided.
      this._state = State.DOCPIP;
      if (stream) this._setStreamOnPipWindow(stream);
      this._currentStream = stream || null;

      // Hide the in-extension floating cam — face is in the docpip window
      if (this._floatingCamEl) this._floatingCamEl.style.display = 'none';

      log.info('DOCPIP opened, epoch=', epoch);
      return true;
    }

    /**
     * Update the stream shown in whichever surface is active.
     * Idempotent: setting the same stream is a no-op.
     */
    setStream(stream) {
      if (!stream) return;
      if (this._currentStream === stream) return;
      this._currentStream = stream;

      if (this._state === State.DOCPIP) {
        this._setStreamOnPipWindow(stream);
      } else if (this._state === State.FLOATING) {
        this._setStreamOnFloatingCam(stream);
      } else {
        // No active surface yet — caller will likely call showFloating or openDocPip next
      }
    }

    /**
     * Schedule a stream attach when one becomes available. Returns immediately;
     * actual attach happens later. The poll cancels itself if state changes.
     */
    attachWhenReady(getStream, { intervalMs = 400, maxAttempts = 15 } = {}) {
      const epoch = this._epoch;
      let attempts = 0;
      const tick = () => {
        if (epoch !== this._epoch) {
          log.debug('attachWhenReady cancelled (epoch changed)');
          return;
        }
        attempts++;
        const s = getStream();
        if (s && s.getVideoTracks().some(t => t.readyState === 'live')) {
          this.setStream(s);
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(tick, intervalMs);
        }
      };
      setTimeout(tick, 200);
    }

    /** Close docpip if open, return to floating-cam if a stream is active. */
    closeDocPipReturnToFloating() {
      if (this._state !== State.DOCPIP) return;
      const stream = this._currentStream;
      this._closeDocPipQuietly();
      if (stream && this._floatingCamEl) {
        this.showFloating(stream);
      }
    }

    /** Hide everything. Releases all stream references. */
    hideAll() {
      ++this._epoch; // cancel any pending polls
      this._closeDocPipQuietly();
      if (this._floatingCamEl) this._floatingCamEl.style.display = 'none';
      this._clearFloatingCamStream();
      this._currentStream = null;
      this._state = State.IDLE;
      log.debug('hideAll → IDLE');
    }

    /** Permanently dispose. Call on full cleanup (popup unload). */
    destroy() {
      this.hideAll();
      this._popoutAbort?.abort();
      this._popoutAbort = null;
      this._floatingCamEl = null;
      this._floatingCamVideoEl = null;
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    _setStreamOnPipWindow(stream) {
      const v = this._pipVideoEl;
      if (!v) return;
      // Only assign if different — re-assigning the same MediaStream causes
      // an internal restart and momentary black frame.
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        v.play().catch(() => {});
      }
    }

    _setStreamOnFloatingCam(stream) {
      const v = this._floatingCamVideoEl;
      if (!v) return;
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        v.play().catch(() => {});
      }
    }

    _clearFloatingCamStream() {
      const v = this._floatingCamVideoEl;
      if (v && v.srcObject) {
        // Don't stop the tracks here — they're owned by the WebRTC pipeline.
        // Just detach the reference so the <video> doesn't hold them alive.
        v.srcObject = null;
      }
    }

    _closeDocPipQuietly() {
      try { this._pipAbort?.abort(); } catch (_) {}
      this._pipAbort = null;

      if (this._pipVideoEl) {
        try { this._pipVideoEl.srcObject = null; } catch (_) {}
        this._pipVideoEl = null;
      }
      if (this._pipWindow && !this._pipWindow.closed) {
        try { this._pipWindow.close(); } catch (_) {}
      }
      this._pipWindow = null;
    }

    _handlePipClosed(originatingEpoch) {
      // Could be a stale pagehide from a previous PiP window — guard.
      if (originatingEpoch !== this._epoch) {
        log.debug('Ignoring stale pagehide (epoch changed)');
        return;
      }
      log.info('DOCPIP closed by user');
      const stream = this._currentStream;

      // Tear down docpip refs
      try { this._pipAbort?.abort(); } catch (_) {}
      this._pipAbort = null;
      this._pipVideoEl = null;
      this._pipWindow = null;

      // If a stream is still active, fall back to floating cam.
      // Caller (popup.js) decides whether to actually show it via the
      // 'docpipclosed' callback — see onDocPipClosed.
      this._state = State.IDLE;
      if (this._onDocPipClosed) {
        try { this._onDocPipClosed(stream); } catch (e) { log.warn('onDocPipClosed threw', e); }
      } else if (stream && this._floatingCamEl) {
        // Default behaviour: fall back to floating cam
        this.showFloating(stream);
      }
    }

    /**
     * Register a callback fired when the user closes the Document PiP window.
     * Receives the last stream as argument so caller can decide whether to
     * fall back to floating cam.
     */
    onDocPipClosed(fn) {
      this._onDocPipClosed = fn;
    }

    _popOutToDocPipFromButton() {
      const stream = this._currentStream;
      if (!stream) {
        log.warn('Pop-out clicked but no stream available');
        return;
      }
      // openDocPip is async — if it fails we stay in floating mode.
      this.openDocPip({ stream }).catch((e) => log.warn('openDocPip failed:', e));
    }
  }

  window.CWPipManager = new PipManager();
})();
