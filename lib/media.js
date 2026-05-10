// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Media Manager
//
// Owns the local cam/mic stream and the screen-share stream lifecycles.
// Centralised here (rather than scattered in popup.js) so that:
//   • There's one place to update constraints
//   • Track stops are deterministic on cleanup
//   • Errors get categorised consistently for the user
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('media');

  const MIC_CONSTRAINTS = Object.freeze({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 1,
    latency: 0,
  });

  const CAM_CONSTRAINTS = Object.freeze({
    width:     { ideal: 640, max: 1280 },
    height:    { ideal: 480, max: 720  },
    frameRate: { ideal: 24,  max: 30   },
  });

  const SCREEN_VIDEO_CONSTRAINTS = Object.freeze({
    cursor: 'always',
    frameRate: { ideal: 30, max: 30 },
    width:  { ideal: 1280 },
    height: { ideal: 720 },
    displaySurface: 'monitor',
  });

  const SCREEN_AUDIO_CONSTRAINTS = Object.freeze({
    systemAudio: 'include',
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 2,
  });

  class MediaManager {
    constructor() {
      this.localStream = null;
      this.screenStream = null;
    }

    /**
     * Acquire camera + mic (both ideal). Falls back to mic-only if camera
     * unavailable. Throws if neither is available.
     *
     * Returns: { stream: MediaStream, hasVideo: boolean, hasAudio: boolean }
     */
    async acquireLocalStream() {
      // Already have one? Reuse — getUserMedia again would pop a permission
      // prompt twice in some Chrome versions and create duplicate tracks.
      if (this.localStream && this.localStream.active) {
        return {
          stream: this.localStream,
          hasVideo: this.localStream.getVideoTracks().length > 0,
          hasAudio: this.localStream.getAudioTracks().length > 0,
        };
      }

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: CAM_CONSTRAINTS,
          audio: MIC_CONSTRAINTS,
        });
        log.info('Acquired cam+mic');
        return { stream: this.localStream, hasVideo: true, hasAudio: true };
      } catch (e) {
        log.warn('Cam+mic acquisition failed, trying mic-only:', e?.message);
      }

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
        log.info('Acquired mic-only');
        return { stream: this.localStream, hasVideo: false, hasAudio: true };
      } catch (e) {
        log.error('Mic-only acquisition failed:', e?.message);
        throw new Error('media-permission-denied');
      }
    }

    /**
     * Acquire screen share. Tries the rich constraints first; falls back to
     * a minimal version only on constraint/capability errors.
     * Permission denials and user cancellations short-circuit immediately.
     *
     * Returns: MediaStream | null  (null if user cancelled or denied)
     */
    async acquireScreenStream() {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: SCREEN_VIDEO_CONSTRAINTS,
          audio: SCREEN_AUDIO_CONSTRAINTS,
        });
      } catch (e) {
        // NotAllowedError  → user denied or dismissed the picker — no point retrying.
        // AbortError       → user cancelled mid-flow — same, bail silently.
        if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
          log.info('Screen share cancelled or denied by user — not retrying.');
          return null;
        }
        // For all other failures (OverconstrainedError, NotSupportedError, etc.)
        // retry with minimal constraints in case the rich ones aren't supported.
        log.warn('Display media (rich) failed, retrying with minimal:', e?.message);
        try {
          this.screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always', frameRate: { ideal: 30 } },
            audio: true,
          });
        } catch (e2) {
          log.warn('Display media (minimal) also failed:', e2?.message);
          return null;
        }
      }

      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) {
        // 'motion' is correct for general screen share (smooth video, gameplay)
        videoTrack.contentHint = 'motion';
      }
      log.info('Acquired screen share');
      return this.screenStream;
    }

    /** Stop all tracks of the screen stream. Idempotent. */
    stopScreenStream() {
      if (this.screenStream) {
        this.screenStream.getTracks().forEach(t => {
          try { t.stop(); } catch (_) {}
        });
        this.screenStream = null;
        log.info('Screen stream stopped');
      }
    }

    /** Stop ALL tracks (cam + mic + screen). Used on cleanup. */
    stopAll() {
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => {
          try { t.stop(); } catch (_) {}
        });
        this.localStream = null;
      }
      this.stopScreenStream();
      log.info('All media stopped');
    }
  }

  window.CWMedia = new MediaManager();
})();
