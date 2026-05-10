// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Network Monitor
//
// Replaces the v13 22-second blind-fire toast with a real connectivity check
// that combines:
//   1. navigator.onLine                — fast browser-level signal
//   2. Active Firebase reachability    — verifies the actual signaling backend
//   3. ICE connection state            — reflects WebRTC peer connectivity
//
// The "check your internet" warning is ONLY shown when at least one of these
// gives a real negative signal — never just because ICE is taking longer than
// usual on a healthy network.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('net');

  class NetworkMonitor {
    constructor() {
      this._online = (typeof navigator !== 'undefined' && navigator.onLine !== false);
      this._listeners = new Set();
      this._lastBackendCheck = 0;
      this._lastBackendOk = null;
      this._BACKEND_CHECK_TTL_MS = 15000;

      if (typeof window !== 'undefined') {
        window.addEventListener('online',  () => this._setOnline(true));
        window.addEventListener('offline', () => this._setOnline(false));
      }
    }

    /** Subscribe to online/offline transitions. Returns an unsubscribe fn. */
    subscribe(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    }

    _setOnline(online) {
      if (this._online === online) return;
      this._online = online;
      log.info('navigator.onLine →', online);
      this._listeners.forEach((fn) => {
        try { fn(online); } catch (e) { log.warn('listener threw', e); }
      });
    }

    /** Synchronous best-effort: navigator.onLine. */
    get isOnline() {
      return this._online;
    }

    /**
     * Active reachability probe against the configured Firebase backend.
     * Cached for `_BACKEND_CHECK_TTL_MS` so repeat callers don't hammer it.
     *
     * Returns: { ok: boolean, reason: string, latencyMs: number|null }
     */
    async probeBackend({ force = false, timeoutMs = 5000 } = {}) {
      const now = Date.now();
      if (!force
          && this._lastBackendOk !== null
          && now - this._lastBackendCheck < this._BACKEND_CHECK_TTL_MS) {
        return this._lastBackendOk;
      }

      const url = window.CW_CONFIG?.firebaseDatabaseUrl;
      if (!url || !url.startsWith('https://') || url.includes('YOUR-PROJECT')) {
        const result = { ok: false, reason: 'firebase-not-configured', latencyMs: null };
        this._lastBackendOk = result;
        this._lastBackendCheck = now;
        return result;
      }

      const probeUrl = `${url.replace(/\/+$/, '')}/.json?shallow=true`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
      const t0 = performance.now();
      let result;

      try {
        const r = await fetch(probeUrl, { method: 'GET', signal: ctl.signal });
        const latencyMs = Math.round(performance.now() - t0);
        // Firebase returns 200 for any read; 401/403 means rules blocked us
        // (still indicates the backend itself is reachable).
        if (r.ok || r.status === 401 || r.status === 403) {
          result = { ok: true, reason: 'reachable', latencyMs };
        } else {
          result = { ok: false, reason: `http-${r.status}`, latencyMs };
        }
      } catch (err) {
        const latencyMs = Math.round(performance.now() - t0);
        if (err?.name === 'AbortError') {
          result = { ok: false, reason: 'timeout', latencyMs };
        } else if (!this._online) {
          result = { ok: false, reason: 'offline', latencyMs };
        } else {
          result = { ok: false, reason: 'fetch-failed', latencyMs };
        }
      } finally {
        clearTimeout(timer);
      }

      this._lastBackendOk = result;
      this._lastBackendCheck = now;
      log.info('backend probe', result);
      return result;
    }

    /**
     * Returns a human-friendly diagnostic — used to decide whether to show
     * the "check your internet" warning AND with what message.
     *
     * Returns: { healthy: boolean, message: string|null }
     */
    async diagnose() {
      if (!this._online) {
        return { healthy: false, message: 'You appear to be offline. Reconnect to the internet and try again.' };
      }
      const probe = await this.probeBackend();
      if (probe.ok) return { healthy: true, message: null };

      switch (probe.reason) {
        case 'firebase-not-configured':
          return {
            healthy: false,
            message: 'Firebase is not configured. Edit lib/config.js and add your database URL — see README.',
          };
        case 'timeout':
        case 'fetch-failed':
          return {
            healthy: false,
            message: 'Could not reach the signaling server. Check your internet connection.',
          };
        case 'offline':
          return {
            healthy: false,
            message: 'You appear to be offline. Reconnect to the internet and try again.',
          };
        default:
          return {
            healthy: false,
            message: `Signaling server returned an error (${probe.reason}). Try again in a moment.`,
          };
      }
    }
  }

  window.CWNetwork = new NetworkMonitor();
})();
