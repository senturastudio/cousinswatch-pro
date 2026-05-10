// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Audio Mixer
//
// Mixes mic audio + screen-share system audio into a single track that gets
// sent over the call. Uses Web Audio with a DynamicsCompressor for the mic
// path so screen audio doesn't drown out the speaker.
//
// Lifecycle: stop() is fully idempotent and releases the AudioContext so
// repeated start/stop cycles don't accumulate state.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('audio');

  class AudioMixer {
    constructor() {
      this._ctx = null;
      this._destination = null;
      this._micSourceNode = null;
      this._screenSourceNode = null;
      this._micGain = null;
      this._screenGain = null;
      this._compressor = null;
      this._isMixing = false;
    }

    get isMixing() { return this._isMixing; }

    /** Returns the mixed MediaStreamTrack. */
    async start({ micTrack, screenAudioTrack }) {
      if (this._isMixing) {
        log.warn('start() called while already mixing — stopping first');
        await this.stop();
      }
      if (!screenAudioTrack) {
        log.warn('start() called with no screen audio track — nothing to mix');
        return null;
      }

      this._ctx = new AudioContext();
      this._destination = this._ctx.createMediaStreamDestination();

      if (micTrack && micTrack.readyState === 'live') {
        const micStream = new MediaStream([micTrack]);
        this._micSourceNode = this._ctx.createMediaStreamSource(micStream);

        this._micGain = this._ctx.createGain();
        this._micGain.gain.value = 1.3;

        this._compressor = this._ctx.createDynamicsCompressor();
        this._compressor.threshold.value = -24;
        this._compressor.knee.value = 30;
        this._compressor.ratio.value = 4;
        this._compressor.attack.value = 0.003;
        this._compressor.release.value = 0.25;

        this._micSourceNode.connect(this._micGain);
        this._micGain.connect(this._compressor);
        this._compressor.connect(this._destination);
      } else {
        log.warn('No live mic track — mixing screen audio only');
      }

      const screenStream = new MediaStream([screenAudioTrack]);
      this._screenSourceNode = this._ctx.createMediaStreamSource(screenStream);
      this._screenGain = this._ctx.createGain();
      this._screenGain.gain.value = 1.0;
      this._screenSourceNode.connect(this._screenGain);
      this._screenGain.connect(this._destination);

      this._isMixing = true;
      const mixedTrack = this._destination.stream.getAudioTracks()[0];
      log.info('Mixer started', mixedTrack ? 'OK' : '(no track produced)');
      return mixedTrack;
    }

    /** Tear down the mixer and release all Web Audio nodes. Idempotent. */
    async stop() {
      if (!this._isMixing && !this._ctx) return;

      try { this._screenSourceNode?.disconnect(); } catch (_) {}
      try { this._screenGain?.disconnect(); } catch (_) {}
      try { this._micSourceNode?.disconnect(); } catch (_) {}
      try { this._micGain?.disconnect(); } catch (_) {}
      try { this._compressor?.disconnect(); } catch (_) {}

      this._screenSourceNode = null;
      this._screenGain = null;
      this._micSourceNode = null;
      this._micGain = null;
      this._compressor = null;

      if (this._ctx && this._ctx.state !== 'closed') {
        try { await this._ctx.close(); } catch (e) { log.warn('ctx.close() threw', e); }
      }
      this._ctx = null;
      this._destination = null;
      this._isMixing = false;
      log.info('Mixer stopped');
    }
  }

  window.CWAudioMixer = new AudioMixer();
})();
