// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Signaling
//
// Thin wrapper around the custom Peer (lib/peer.js). Same interface as v13:
//   • initWithId(id)              — host starts and waits for guest
//   • initAndJoin(roomId)         — guest opens peer, ready to call host
//   • startGuestCall(stream, cb)  — guest initiates the actual media call
//   • on / send / destroy         — common
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('signal');

  function generateRandomId() {
    // 8 bytes of crypto random → 16 hex chars (~64 bits) — orders of
    // magnitude better than v13's Math.random 6-char ID.
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  class Signaling {
    constructor() {
      this.peer = null;
      this.conn = null;     // DataConnection
      this._queue = [];     // messages queued before data channel opens
      this.onData = null;
      this.onOpen = null;
      this.onCall = null;
      this.onConnection = null;
      this._guestRoomId = null;
    }

    /** HOST: open Peer with given id, listen for guest. */
    initWithId(id) {
      this._destroyOld();
      return new Promise((resolve, reject) => {
        try {
          this.peer = new Peer(id);
        } catch (err) {
          reject(err);
          return;
        }

        this.peer.on('open', (peerId) => {
          log.info('Host peer opened:', peerId);
          this.peer._listenAsHost(peerId);
          resolve(peerId);
        });

        this.peer.on('call', (mediaConn) => {
          log.info('Incoming call from guest');
          this.onCall?.(mediaConn);
        });

        this.peer.on('connection', (dataConn) => {
          log.info('Data channel connected');
          this.conn = dataConn;
          this._bindDataConn(dataConn);
          this.onConnection?.();
        });

        this.peer.on('error', (err) => {
          log.error('Host peer error:', err);
          reject(err);
        });
      });
    }

    /** GUEST: open Peer with random ID, ready to call host. */
    initAndJoin(roomId) {
      this._destroyOld();
      return new Promise((resolve, reject) => {
        const guestId = 'CW-' + generateRandomId() + '-G';
        try {
          this.peer = new Peer(guestId);
        } catch (err) {
          reject(err);
          return;
        }

        this.peer.on('open', (peerId) => {
          log.info('Guest peer opened:', peerId);
          this._guestRoomId = roomId;
          resolve(peerId);
        });

        this.peer.on('error', (err) => {
          log.error('Guest peer error:', err);
          reject(err);
        });
      });
    }

    /** GUEST: actually start the media call once popup is ready. */
    startGuestCall(localStream, onMediaConn) {
      if (!this.peer || !this._guestRoomId) {
        log.warn('startGuestCall: peer or roomId missing');
        return;
      }
      const roomId = this._guestRoomId;
      const mediaConn = this.peer.call(roomId, localStream);
      if (!mediaConn) {
        log.error('startGuestCall: peer.call returned null');
        return;
      }
      onMediaConn(mediaConn);

      const dataConn = this.peer.connect(roomId);
      this.conn = dataConn;
      this._bindDataConn(dataConn);
    }

    _bindDataConn(dataConn) {
      dataConn.on('open', () => {
        log.info('Data channel open');
        this._queue.forEach(msg => dataConn.send(msg));
        this._queue = [];
        this.onOpen?.();
      });
      dataConn.on('data', (data) => this.onData?.(data));
      dataConn.on('error', (err) => {
        const detail = err?.error ?? err;
        log.warn('Data channel error:', detail?.message ?? detail);
      });
    }

    send(data) {
      if (this.conn?.channel?.readyState === 'open') {
        this.conn.send(data);
      } else {
        this._queue.push(data);
      }
    }

    _destroyOld() {
      const old = this.peer;
      if (old && !old._destroyed) {
        try { if (old.id) old.destroy(); } catch (_) {}
      }
      this.peer = null;
      this.conn = null;
      this._queue = [];
      this._guestRoomId = null;
    }

    destroy() { this._destroyOld(); }
  }

  window.Signaling = Signaling;
  window.CWGenerateRoomId = generateRandomId;
})();
