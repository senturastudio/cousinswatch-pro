// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — Configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️  YOU MUST EDIT THIS FILE BEFORE USING THE EXTENSION  ⚠️
//
// Replace `firebaseDatabaseUrl` below with your own Firebase Realtime Database
// URL. See README.md → "Firebase Configuration" for step-by-step setup
// instructions.
//
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  /**
   * Public configuration. Anything sensitive (private keys, service-account
   * credentials) MUST NOT live here — this file ships in the extension and is
   * readable by anyone who installs it.
   *
   * What you put in `firebaseDatabaseUrl` is fine to be public IF you also
   * set Firebase Security Rules that lock down access (see README).
   */
  const CW_CONFIG = Object.freeze({
    /**
     * Your Firebase Realtime Database URL.
     *
     *   Format: https://<project-id>-default-rtdb.firebaseio.com
     *       or: https://<project-id>-default-rtdb.<region>.firebasedatabase.app
     *
     * Find it in the Firebase console → Realtime Database → "Data" tab,
     * just below the green padlock icon.
     */
    firebaseDatabaseUrl: 'https://cousinswatch-dedef-default-rtdb.firebaseio.com',

    /**
     * ICE servers used by WebRTC for NAT traversal.
     * - STUN servers below are public and free.
     * - TURN servers are needed when peers can't reach each other directly
     *   (~15% of calls). The included OpenRelay credentials are a public
     *   testing service — for production, replace with your own coturn server
     *   (~$5/mo VPS). See README → "Self-hosted TURN".
     */
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // Replace with your own TURN server for production use.
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turns:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],

    /** Logging verbosity: 'debug' | 'info' | 'warn' | 'error' | 'silent' */
    logLevel: 'info',

    /**
     * How long to wait for ICE to reach 'connected' before warning the user
     * about possible network issues. Only fires if we ALSO observe an actual
     * problem signal (failed/disconnected) or `navigator.onLine === false`.
     */
    iceConnectTimeoutMs: 25000,
  });

  // Expose globally for other scripts in the popup.
  // We freeze so accidental writes elsewhere can't change the config.
  window.CW_CONFIG = CW_CONFIG;
})();
