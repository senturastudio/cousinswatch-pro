// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — WebRTC client
//
// Same architecture as v13/v9 (proven lag-fix from the previous round):
//   • H264 preferred for screen share — hardware encoder, near-zero CPU
//   • degradationPreference = 'maintain-framerate' for screen share
//   • Receivers tuned (playoutDelayHint=0, jitterBufferTarget=50ms)
//   • Adaptive bitrate using availableOutgoingBitrate (browser's GCC estimate)
//
// Refactor changes vs v13:
//   • Uses CWMakeLogger instead of console.log
//   • Defensive null-checks before every pc/sender access
//   • close() releases _onIceStateCb to drop closure references
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('rtc');

  class WebRTCClient {
    constructor({ mediaConn, onTrack, onConnectionState }) {
      this._mc = mediaConn;
      this.pc = mediaConn.peerConnection;
      this.onBitrateLog = null;

      this._adaptTimer = null;
      this._lastPacketsSent = 0;
      this._lastPacketsLost = 0;
      this._adaptSkipTicks = 1;
      this._currentVideoMaxBitrate = 0;
      this._isScreenSharing = false;

      this.BITRATE_WEBCAM_HIGH = 800_000;
      this.BITRATE_WEBCAM_MED  = 350_000;
      this.BITRATE_WEBCAM_LOW  = 120_000;
      this.BITRATE_SCREEN      = 3_000_000;
      this.BITRATE_AUDIO       = 128_000;

      mediaConn.on('track', (track, stream) => {
        if (!stream || track.readyState === 'ended') return;
        onTrack?.(track, stream);
      });

      mediaConn.on('stream', (stream) => {
        if (!stream) return;
        stream.getTracks()
          .filter(t => t.readyState !== 'ended')
          .forEach(track => onTrack?.(track, stream));
      });

      mediaConn.on('icestate', (state) => {
        this._onIceStateCb?.(state);
        if (state === 'connected' || state === 'completed') {
          onConnectionState?.('connected');
          this._tuneReceivers();
        } else if (state === 'failed') {
          onConnectionState?.('failed');
        } else if (state === 'disconnected') {
          onConnectionState?.('disconnected');
        }
      });

      mediaConn.on('close', () => onConnectionState?.('closed'));
    }

    _tuneReceivers() {
      if (!this.pc) return;
      try {
        this.pc.getReceivers().forEach((r) => {
          if (r.track?.kind !== 'video') return;
          if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
          if ('jitterBufferTarget' in r) r.jitterBufferTarget = 50;
        });
      } catch (e) { log.warn('tune receivers failed:', e.message); }
    }

    answer(localStream) { this._mc.answer(localStream); }

    async replaceAudioTrack(track) {
      if (!this.pc) return;
      const sender = this.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(track);
    }

    onIceState(cb) { this._onIceStateCb = cb; }

    // ── Screen share ─────────────────────────────────────────────────────────
    async startScreenShare(screenTrack) {
      if (!this.pc) return;
      this._isScreenSharing = true;
      this._setScreenCodecPreference();
      const videoSender = this.pc.getSenders().find(s => s.track?.kind === 'video');
      if (!videoSender) return;
      await videoSender.replaceTrack(screenTrack);
      await new Promise(r => setTimeout(r, 50));
      await this._applyScreenEncodings(videoSender);
      this._requestKeyframe(videoSender);
      this._tuneReceivers();
    }

    async stopScreenShare(cameraTrack) {
      if (!this.pc) return;
      this._isScreenSharing = false;
      const videoSender = this.pc.getSenders().find(s => s.track?.kind === 'video');
      if (!videoSender) return;
      if (cameraTrack) await videoSender.replaceTrack(cameraTrack);
      await new Promise(r => setTimeout(r, 50));
      this._setWebcamCodecPreference();
      await this._applyWebcamEncodings(videoSender);
      this._requestKeyframe(videoSender);
    }

    async activateWebcamSlot(camTrack) { await this._mc.activateWebcamSlot(camTrack); }
    async deactivateWebcamSlot() { await this._mc.deactivateWebcamSlot(); }
    getWebcamReceiver() { return this._mc.getWebcamReceiver(); }

    async _applyScreenEncodings(sender) {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings.forEach((enc, i) => {
        if (i === 0) {
          enc.active = true;
          enc.maxBitrate = this.BITRATE_SCREEN;
          enc.maxFramerate = 30;
          enc.priority = 'high';
          enc.networkPriority = 'high';
          delete enc.scaleResolutionDownBy;
        } else {
          enc.active = false;
        }
      });
      params.degradationPreference = 'maintain-framerate';
      try {
        await sender.setParameters(params);
        this._currentVideoMaxBitrate = this.BITRATE_SCREEN;
      } catch (e) { log.warn('setParameters (screen):', e.message); }
    }

    async _applyWebcamEncodings(sender) {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if (params.encodings.length >= 3) {
        const tiers = [
          { bitrate: this.BITRATE_WEBCAM_HIGH, scale: 1, fps: 30 },
          { bitrate: this.BITRATE_WEBCAM_MED,  scale: 2, fps: 24 },
          { bitrate: this.BITRATE_WEBCAM_LOW,  scale: 4, fps: 15 },
        ];
        params.encodings.forEach((enc, i) => {
          const t = tiers[i] || tiers[2];
          enc.active = true;
          enc.maxBitrate = t.bitrate;
          enc.maxFramerate = t.fps;
          enc.scaleResolutionDownBy = t.scale;
          delete enc.priority;
          delete enc.networkPriority;
        });
      } else {
        params.encodings[0].active = true;
        params.encodings[0].maxBitrate = this.BITRATE_WEBCAM_HIGH;
        params.encodings[0].maxFramerate = 30;
      }
      params.degradationPreference = 'balanced';
      try {
        await sender.setParameters(params);
        this._currentVideoMaxBitrate = this.BITRATE_WEBCAM_HIGH;
      } catch (e) { log.warn('setParameters (webcam):', e.message); }
    }

    _requestKeyframe(sender) {
      if (typeof sender.generateKeyFrame === 'function') {
        sender.generateKeyFrame().catch(() => {});
      }
    }

    _setScreenCodecPreference() {
      try {
        const tc = this._getVideoTransceiver();
        if (!tc) return;
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (!caps) return;
        const order = ['video/H264', 'video/VP8', 'video/VP9'];
        const sorted = [...caps.codecs].sort((a, b) => {
          const ia = order.indexOf(a.mimeType), ib = order.indexOf(b.mimeType);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        tc.setCodecPreferences(sorted);
      } catch (_) {}
    }

    _setWebcamCodecPreference() {
      try {
        const tc = this._getVideoTransceiver();
        if (!tc) return;
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (!caps) return;
        const order = ['video/VP9', 'video/H264', 'video/VP8'];
        const sorted = [...caps.codecs].sort((a, b) => {
          const ia = order.indexOf(a.mimeType), ib = order.indexOf(b.mimeType);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        tc.setCodecPreferences(sorted);
      } catch (_) {}
    }

    _getVideoTransceiver() {
      if (!this.pc) return null;
      return this.pc.getTransceivers().find(t =>
        t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video'
      ) ?? null;
    }

    // ── Adaptive bitrate ─────────────────────────────────────────────────────
    startAdaptiveBitrate(isScreen = false) {
      this.stopAdaptiveBitrate();
      this._adaptSkipTicks = 1;
      this._lastPacketsSent = 0;
      this._lastPacketsLost = 0;
      this._currentVideoMaxBitrate = isScreen ? this.BITRATE_SCREEN : this.BITRATE_WEBCAM_HIGH;
      this._adaptTimer = setInterval(() => this._adaptTick(isScreen), 2000);
    }

    async _adaptTick(isScreen) {
      if (!this.pc) return;
      let rtt = 0, packetsSent = 0, packetsLost = 0, availableBitrate = 0;
      try {
        const stats = await this.pc.getStats();
        stats.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded') {
            if (r.currentRoundTripTime)     rtt              = r.currentRoundTripTime;
            if (r.availableOutgoingBitrate) availableBitrate = r.availableOutgoingBitrate;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            packetsSent = r.packetsSent || 0;
            packetsLost = r.packetsLost || 0;
          }
        });
      } catch (_) { return; }

      if (this._adaptSkipTicks > 0) {
        this._adaptSkipTicks--;
        this._lastPacketsSent = packetsSent;
        this._lastPacketsLost = packetsLost;
        return;
      }

      const deltaSent = Math.max(1, packetsSent - this._lastPacketsSent);
      const deltaLost = Math.max(0, packetsLost - this._lastPacketsLost);
      const lossRate = deltaLost / deltaSent;
      this._lastPacketsSent = packetsSent;
      this._lastPacketsLost = packetsLost;

      const baseMax = isScreen ? this.BITRATE_SCREEN : this.BITRATE_WEBCAM_HIGH;
      let target = availableBitrate > 0
        ? Math.min(baseMax, Math.round(availableBitrate * 0.85))
        : baseMax;

      if      (lossRate > 0.12 || rtt > 0.6)  target = Math.round(baseMax * 0.35);
      else if (lossRate > 0.07 || rtt > 0.4)  target = Math.round(baseMax * 0.55);
      else if (lossRate > 0.03 || rtt > 0.25) target = Math.round(baseMax * 0.75);

      const floor = isScreen ? 400_000 : 120_000;
      target = Math.max(floor, target);

      if (Math.abs(target - this._currentVideoMaxBitrate) < 50_000) return;
      this._currentVideoMaxBitrate = target;

      const videoSender = this.pc.getSenders().find(s => s.track?.kind === 'video');
      if (!videoSender) return;
      try {
        const params = videoSender.getParameters();
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = target;
          await videoSender.setParameters(params);
        }
      } catch (_) {}

      const kbps = Math.round(target / 1000);
      if (target < baseMax * 0.9) {
        this.onBitrateLog?.(`📶 Bandwidth limited — ${kbps} kbps (RTT ${Math.round(rtt * 1000)} ms, loss ${(lossRate * 100).toFixed(1)}%)`);
      } else {
        this.onBitrateLog?.('📶 Full quality');
      }
    }

    stopAdaptiveBitrate() {
      if (this._adaptTimer) {
        clearInterval(this._adaptTimer);
        this._adaptTimer = null;
      }
    }

    close() {
      this.stopAdaptiveBitrate();
      this._mc?.close();
      this._onIceStateCb = null;
      this.onBitrateLog = null;
      this.pc = null;
    }
  }

  window.WebRTCClient = WebRTCClient;
})();
