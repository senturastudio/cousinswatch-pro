// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Peer (Firebase-backed signaling)
//
// Custom Peer implementation that uses Firebase Realtime Database as the
// signaling channel. Compatible with v13's API (Peer.call / Peer.connect /
// Peer events) so signaling.js / popup.js don't need to change.
//
// Improvements over v13:
//   • Firebase URL comes from window.CW_CONFIG (no hardcoded URL)
//   • All Firebase paths validated (path traversal protection)
//   • Inbound signaling messages size-checked + schema-validated
//   • ICE candidates validated before addIceCandidate (basic injection guard)
//   • Logger instead of raw console.log
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('peer');
  const cfg = window.CW_CONFIG;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function createBlackVideoTrack() {
    const canvas = Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    return canvas.captureStream(1).getVideoTracks()[0];
  }

  /**
   * Validate that a path component is safe to embed in a Firebase URL.
   * Firebase keys cannot contain `.`, `#`, `$`, `[`, `]`, `/` and we further
   * restrict to a strict alphanumeric + `-` set since all our IDs are CW-prefixed.
   */
  function isSafePathComponent(seg) {
    return typeof seg === 'string'
        && seg.length > 0
        && seg.length <= 64
        && /^[A-Za-z0-9_-]+$/.test(seg);
  }

  function validateAndBuildPath(path) {
    if (typeof path !== 'string' || !path) {
      throw new Error('invalid firebase path');
    }
    const segments = path.split('/').filter(Boolean);
    for (const s of segments) {
      if (!isSafePathComponent(s)) {
        throw new Error(`invalid firebase path segment: ${s}`);
      }
    }
    const fbBase = (cfg?.firebaseDatabaseUrl || '').replace(/\/+$/, '');
    if (!fbBase || !fbBase.startsWith('https://')) {
      throw new Error('CW_CONFIG.firebaseDatabaseUrl is missing or invalid');
    }
    return `${fbBase}/${segments.join('/')}.json`;
  }

  async function fbSet(path, value) {
    const url = validateAndBuildPath(path);
    const r = await fetch(url, { method: 'PUT', body: JSON.stringify(value) });
    if (!r.ok) log.warn('fbSet non-OK', r.status, path);
  }

  async function fbPush(path, value) {
    const url = validateAndBuildPath(path);
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(value) });
    if (!r.ok) log.warn('fbPush non-OK', r.status, path);
  }

  async function fbDelete(path) {
    const url = validateAndBuildPath(path);
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) log.warn('fbDelete non-OK', r.status, path);
  }

  // Maximum payload size for any single Firebase event. SDPs are typically
  // ~5 KB; 64 KB is a generous ceiling.
  const FB_MAX_PAYLOAD_BYTES = 64 * 1024;

  function fbListen(path, onData, fanOut = false) {
    const url = validateAndBuildPath(path);
    const source = new EventSource(url);
    const seenKeys = new Set();

    const handleEvent = (e) => {
      // Reject oversized payloads outright.
      if (typeof e.data === 'string' && e.data.length > FB_MAX_PAYLOAD_BYTES) {
        log.warn('Discarding oversized firebase event:', e.data.length, 'bytes on', path);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(e.data);
      } catch (err) {
        log.warn('fbListen parse error', err);
        return;
      }
      if (!parsed || parsed.data === null) return;

      if (fanOut) {
        if (parsed.path === '/') {
          const data = parsed.data;
          for (const key in data) {
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              onData(data[key], key);
            }
          }
        } else {
          const key = parsed.path.replace('/', '');
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            onData(parsed.data, key);
          }
        }
      } else {
        onData(parsed.data);
      }
    };

    source.addEventListener('put', handleEvent);
    source.addEventListener('patch', handleEvent);
    source.onerror = (e) => log.debug('fbListen EventSource error on', path, e);
    return source;
  }

  // ── Codec preferences (proven from v13 — H264 first for hw encoder) ────────
  const VIDEO_CODEC_PREFERENCE = ['video/H264', 'video/VP9', 'video/VP8'];
  const AUDIO_CODEC_PREFERENCE = ['audio/opus', 'audio/PCMU', 'audio/PCMA'];

  const SIMULCAST_ENCODINGS = [
    { rid: 'high',   maxBitrate: 2500000, scaleResolutionDownBy: 1, maxFramerate: 30, active: true },
    { rid: 'medium', maxBitrate:  800000, scaleResolutionDownBy: 2, maxFramerate: 24, active: true },
    { rid: 'low',    maxBitrate:  250000, scaleResolutionDownBy: 4, maxFramerate: 15, active: true },
  ];

  function sortByMimeTypes(codecs, preferredOrder) {
    return [...codecs].sort((a, b) => {
      const indexA = preferredOrder.indexOf(a.mimeType);
      const indexB = preferredOrder.indexOf(b.mimeType);
      const orderA = indexA >= 0 ? indexA : Number.MAX_VALUE;
      const orderB = indexB >= 0 ? indexB : Number.MAX_VALUE;
      return orderA - orderB;
    });
  }

  /** Lightweight ICE candidate validator — rejects obvious garbage / injection. */
  function isValidIceCandidate(cand) {
    if (!cand || typeof cand !== 'object') return false;
    if (typeof cand.candidate !== 'string') return false;
    if (cand.candidate.length === 0 || cand.candidate.length > 1000) return false;
    // Must look roughly like an RFC 8839 candidate
    if (!/^candidate:\d+ \d+ (UDP|TCP|udp|tcp) \d+ \S+ \d+ typ \w+/i.test(cand.candidate)) {
      return false;
    }
    return true;
  }

  // ── EventEmitter (small, dependency-free) ─────────────────────────────────
  class EventEmitter {
    constructor() { this._handlers = {}; }
    on(event, fn)  { (this._handlers[event] = this._handlers[event] || []).push(fn); }
    off(event, fn) { this._handlers[event] = (this._handlers[event] || []).filter(h => h !== fn); }
    _emit(event, ...args) {
      (this._handlers[event] || []).forEach(fn => {
        try { fn(...args); } catch (e) { log.warn(`handler for ${event} threw`, e); }
      });
    }
  }

  // ── MediaConnection ────────────────────────────────────────────────────────
  class MediaConnection extends EventEmitter {
    constructor(pc) {
      super();
      this.peerConnection = pc;
      this._closed = false;
      this._bufferedStreams = [];
      this._seenStreams = new Set();

      // Deferred answer gate — host waits until popup wires answer() with stream
      this._answerResolve = null;
      this._readyToAnswer = new Promise(r => { this._answerResolve = r; });

      pc.ontrack = (e) => {
        this._emit('track', e.track, e.streams[0]);
        const sid = e.streams[0]?.id;
        if (sid && !this._seenStreams.has(sid)) {
          this._seenStreams.add(sid);
          this._bufferedStreams.push(e.streams[0]);
          this._emit('stream', e.streams[0]);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        log.debug('ICE state:', s);
        this._emit('icestate', s);
        if (s === 'disconnected' || s === 'failed') this._emit('close');
      };

      pc.onconnectionstatechange = () => {
        log.debug('PC state:', pc.connectionState);
      };
    }

    on(event, fn) {
      super.on(event, fn);
      // Replay buffered streams to late subscribers
      if (event === 'stream' && this._bufferedStreams.length) {
        this._bufferedStreams.forEach(s => fn(s));
      }
    }

    answer(stream) {
      stream.getTracks().forEach(track => this.peerConnection.addTrack(track, stream));
      this._answerResolve?.();
    }

    addTrack(track, stream) { this.peerConnection.addTrack(track, stream); }

    async replaceVideoTrack(track) {
      const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    }

    async activateWebcamSlot(track) {
      if (this._camTransceiver) await this._camTransceiver.sender.replaceTrack(track);
    }

    async deactivateWebcamSlot() {
      if (this._camTransceiver) {
        await this._camTransceiver.sender.replaceTrack(createBlackVideoTrack());
      }
    }

    getWebcamReceiver() {
      if (this._camTransceiver) return this._camTransceiver.receiver;
      const allTCs = this.peerConnection.getTransceivers();
      const videoTCs = allTCs.filter(tc =>
        tc.receiver?.track?.kind === 'video' || tc.sender?.track?.kind === 'video'
      );
      return videoTCs[1]?.receiver ?? null;
    }

    getSenders() { return this.peerConnection.getSenders(); }

    close() {
      if (this._closed) return;
      this._closed = true;
      try { this.peerConnection.close(); } catch (_) {}
      this._emit('close');
    }
  }

  // ── DataConnection ─────────────────────────────────────────────────────────
  class DataConnection extends EventEmitter {
    constructor(channel) {
      super();
      this.channel = channel;
      this._isOpen = false;

      // Allowed message types — deny-by-default validator
      this._VALID_TYPES = new Set([
        'SCREEN_START', 'SCREEN_STOP',
        'SCREEN_REQUEST', 'SCREEN_GRANT', 'SCREEN_DENY', 'SCREEN_CANCEL',
      ]);
      this._MAX_MSG_SIZE = 4 * 1024;

      channel.onopen = () => {
        this._isOpen = true;
        this._emit('open');
      };
      channel.onmessage = (e) => {
        const raw = e.data;
        if (typeof raw !== 'string' || raw.length > this._MAX_MSG_SIZE) {
          log.warn('Dropping invalid/oversized data channel message', raw?.length);
          return;
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        if (typeof parsed.type !== 'string' || !this._VALID_TYPES.has(parsed.type)) {
          log.warn('Dropping unknown data channel message type:', parsed.type);
          return;
        }
        this._emit('data', parsed);
      };
      channel.onerror = (e) => {
        if (!this._isOpen) return;
        const msg = e?.error?.message ?? '';
        if (msg.includes('Close called') || msg.includes('User-Initiated Abort')) return;
        this._emit('error', e);
      };
      channel.onclose = () => this._emit('close');
    }
    send(data) {
      if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(data));
    }
  }

  // ── Peer ───────────────────────────────────────────────────────────────────
  class Peer extends EventEmitter {
    constructor(id, config = {}) {
      super();
      if (!isSafePathComponent(id)) {
        throw new Error(`Peer: invalid id "${id}"`);
      }
      this.id = id;
      this.iceServers = config.config?.iceServers || cfg?.iceServers || [];
      this.sources = [];
      this._destroyed = false;
      setTimeout(() => this._emit('open', id), 60);
    }

    _createPC() {
      const pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        bundlePolicy: 'max-bundle',
        iceTransportPolicy: 'all',
        rtcpMuxPolicy: 'require',
      });
      pc.onerror = (e) => this._emit('error', e);
      return pc;
    }

    // ── GUEST: initiate call ────────────────────────────────────────────────
    call(remoteId, localStream) {
      if (!isSafePathComponent(remoteId)) {
        log.error('call: invalid remoteId', remoteId);
        return null;
      }
      const pc = this._createPC();

      // Audio + codec prefs
      localStream.getAudioTracks().forEach(t => {
        const sender = pc.addTrack(t, localStream);
        try {
          const tc = pc.getTransceivers().find(tc => tc.sender === sender);
          if (tc) {
            const codecs = RTCRtpReceiver.getCapabilities('audio')?.codecs;
            if (codecs) tc.setCodecPreferences(sortByMimeTypes(codecs, AUDIO_CODEC_PREFERENCE));
          }
        } catch (e) { log.debug('Audio codec pref failed:', e.message); }
      });

      // Video with simulcast
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          const videoTransceiver = pc.addTransceiver(videoTrack, {
            direction: 'sendrecv',
            streams: [localStream],
            sendEncodings: SIMULCAST_ENCODINGS,
          });
          this._videoTransceiver = videoTransceiver;
          try {
            const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
            if (codecs) videoTransceiver.setCodecPreferences(sortByMimeTypes(codecs, VIDEO_CODEC_PREFERENCE));
          } catch (e) { log.debug('Video codec pref failed:', e.message); }
        } catch (e) {
          pc.addTrack(videoTrack, localStream);
          log.warn('Simulcast not supported, using addTrack fallback');
        }
      }

      // Pre-negotiated webcam slot (used during screen share)
      const blankVideo = createBlackVideoTrack();
      const camTransceiver = pc.addTransceiver(blankVideo, { direction: 'sendrecv', streams: [] });
      this._camTransceiver = camTransceiver;

      this.dataChannel = pc.createDataChannel('sync');
      const mediaConn = new MediaConnection(pc);
      mediaConn._camTransceiver = camTransceiver;

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          fbPush(`rooms/${remoteId}/guest_candidates`, e.candidate.toJSON()).catch((err) =>
            log.warn('push candidate failed', err)
          );
        }
      };

      pc.createOffer()
        .then(sdp => pc.setLocalDescription(sdp).then(() =>
          fbSet(`rooms/${remoteId}/offer`, sdp)
        ))
        .catch(err => log.error('createOffer error', err));

      let answerSet = false;
      this.sources.push(fbListen(`rooms/${remoteId}/answer`, async (answer) => {
        if (!answer || answer.type !== 'answer' || answerSet) return;
        if (pc.signalingState !== 'have-local-offer') {
          log.warn('Ignoring answer in state:', pc.signalingState);
          return;
        }
        answerSet = true;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          this.sources.push(fbListen(`rooms/${remoteId}/host_candidates`, cand => {
            if (!isValidIceCandidate(cand)) {
              log.warn('Discarding invalid host candidate');
              return;
            }
            pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => log.debug('addIceCandidate', e));
          }, true));
        } catch (err) {
          log.error('setRemoteDescription (answer) failed:', err);
        }
      }));

      return mediaConn;
    }

    // ── HOST: listen for incoming guest ─────────────────────────────────────
    _listenAsHost(roomId) {
      if (!isSafePathComponent(roomId)) {
        log.error('_listenAsHost: invalid roomId', roomId);
        return;
      }

      Promise.all([
        fbDelete(`rooms/${roomId}/offer`),
        fbDelete(`rooms/${roomId}/answer`),
        fbDelete(`rooms/${roomId}/host_candidates`),
        fbDelete(`rooms/${roomId}/guest_candidates`),
      ]).catch(e => log.warn('host pre-cleanup failed', e));

      let offerHandled = false;

      this.sources.push(fbListen(`rooms/${roomId}/offer`, async (offer) => {
        if (!offer || offer.type !== 'offer' || offerHandled) return;
        offerHandled = true;

        const pc = this._createPC();
        pc.ondatachannel = (e) => this._emit('connection', new DataConnection(e.channel));
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            fbPush(`rooms/${roomId}/host_candidates`, e.candidate.toJSON()).catch(err =>
              log.warn('push host candidate failed', err)
            );
          }
        };

        try {
          // Wire ontrack BEFORE setRemoteDescription so guest's tracks are seen
          const mediaConn = new MediaConnection(pc);

          await pc.setRemoteDescription(new RTCSessionDescription(offer));

          // Apply codec preference on host side too
          try {
            const tcvs = pc.getTransceivers();
            const audioCaps = RTCRtpReceiver.getCapabilities('audio')?.codecs;
            const videoCaps = RTCRtpReceiver.getCapabilities('video')?.codecs;
            for (const tc of tcvs) {
              const kind = tc.receiver?.track?.kind || tc.sender?.track?.kind;
              if (kind === 'audio' && audioCaps) {
                tc.setCodecPreferences(sortByMimeTypes(audioCaps, AUDIO_CODEC_PREFERENCE));
              } else if (kind === 'video' && videoCaps) {
                tc.setCodecPreferences(sortByMimeTypes(videoCaps, VIDEO_CODEC_PREFERENCE));
              }
            }
          } catch (e) { log.debug('Host codec pref failed:', e.message); }

          this.sources.push(fbListen(`rooms/${roomId}/guest_candidates`, cand => {
            if (!isValidIceCandidate(cand)) {
              log.warn('Discarding invalid guest candidate');
              return;
            }
            pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => log.debug('addIceCandidate', e));
          }, true));

          this._emit('call', mediaConn);
          await mediaConn._readyToAnswer;
          await new Promise(r => setTimeout(r, 0));

          // Tag the second video transceiver as the webcam slot
          const allTCs = pc.getTransceivers();
          const videoTCs = allTCs.filter(tc =>
            tc.receiver?.track?.kind === 'video' || tc.sender?.track?.kind === 'video'
          );
          const camTC = videoTCs[1];
          if (camTC) {
            const blankVideo = createBlackVideoTrack();
            await camTC.sender.replaceTrack(blankVideo);
            camTC.direction = 'sendrecv';
            mediaConn._camTransceiver = camTC;
          }

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await fbSet(`rooms/${roomId}/answer`, answer);

        } catch (err) {
          log.error('Host signaling error:', err);
          offerHandled = false;
        }
      }));
    }

    connect(remoteId) {
      if (!this.dataChannel) {
        log.error('connect() called before dataChannel exists');
        return new EventEmitter();
      }
      return new DataConnection(this.dataChannel);
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.sources.forEach(s => { try { s.close(); } catch (_) {} });
      this.sources = [];
      // Only host (id without -G suffix) cleans up the room node
      if (!this.id.endsWith('-G')) {
        fbDelete(`rooms/${this.id}`).catch(e => log.warn('room cleanup failed', e));
      }
    }
  }

  // Expose the same global as v13 so signaling.js works unchanged
  window.Peer = Peer;
})();
