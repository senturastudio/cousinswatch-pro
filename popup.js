// ─────────────────────────────────────────────────────────────────────────────
// CousinsWatch PRO — popup.js (coordinator)
//
// This file orchestrates the modules in lib/. The bulk of the logic lives in:
//   • lib/peer.js       — Firebase signaling + RTCPeerConnection
//   • lib/signaling.js  — Peer wrapper with onCall/onConnection/onData
//   • lib/webrtc.js     — codec/bitrate/screen-share lifecycle
//   • lib/media.js      — getUserMedia / getDisplayMedia
//   • lib/pip.js        — PiP window + floating cam state machine (key fix)
//   • lib/audio-mixer.js — Web Audio mixer for screen audio + mic
//   • lib/network.js    — connectivity diagnostics (replaces the false toast)
//
// This file should stay UI-focused: DOM bindings, layout transitions, user
// interactions. Anything that does I/O or owns lifecycle of a long-lived
// resource belongs in lib/.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const log = window.CWMakeLogger('popup');
  const network = window.CWNetwork;
  const media = window.CWMedia;
  const mixer = window.CWAudioMixer;
  const pip = window.CWPipManager;

  // ── App state ──────────────────────────────────────────────────────────────
  let signaling = null;
  let rtc = null;
  let isConnected = false;
  let videoEnabled = true;
  let audioEnabled = true;
  let isSharingScreen = false;
  let _remoteIsScreenSharing = false;
  let _lastGoodRemoteStream = null;
  let _iceTimeoutTimer = null;
  let _myWindowId = null;
  let screenZoom = 1;
  let _isMonitorShare = false;   // true when sharing a full monitor (mirror-guard active)

  // ── Screen-share mutex ─────────────────────────────────────────────────────
  // Prevents a race condition where two users click "Share Screen" at the same
  // time, both pass the _remoteIsScreenSharing guard (which hasn't been set yet
  // because neither SCREEN_START has arrived), and both end up sharing.
  //
  // Protocol (optimistic lock with deterministic tie-break):
  //   1. Requester sends SCREEN_REQUEST containing their own peer ID.
  //   2. Receiver replies SCREEN_GRANT or SCREEN_DENY.
  //   3. Requester only calls startScreenShare() after receiving SCREEN_GRANT.
  //
  // Tie-break for simultaneous requests: the peer whose ID is lexicographically
  // *smaller* wins. Both sides apply the same rule, so they always agree.
  //
  // _screenRequestPending — true while we are waiting for SCREEN_GRANT/DENY.
  let _screenRequestPending = false;

  // ── DOM helper ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function logUI(msg) {
    const el = $('logBar');
    if (el) el.textContent = '> ' + msg;
    log.debug(msg);
  }

  function showToast(msg, duration = 3500) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.bottom = '20px';
    setTimeout(() => { t.style.bottom = '-50px'; }, duration);
  }

  function setStatus(state) {
    const badge = $('statusBadge');
    if (!badge) return;
    badge.className = `status-badge status-${state}`;
    const labels = { connected: 'Live', connecting: 'Connecting', offline: 'Offline' };
    badge.textContent = labels[state] || state;
  }

  // ── Stream → DOM helpers ──────────────────────────────────────────────────
  function setLocalStream(stream) {
    const lv = $('localVideo');
    const plv = $('pipLocalVideo');
    const lph = $('localPH');
    if (lv  && lv.srcObject  !== stream) lv.srcObject  = stream;
    if (plv && plv.srcObject !== stream) plv.srcObject = stream;
    if (lph) lph.style.display = stream ? 'none' : 'flex';
  }

  function setRemoteStream(stream) {
    if (stream) _lastGoodRemoteStream = stream;
    const rv  = $('remoteVideo');
    const prv = $('pipRemoteVideo');
    const rph = $('remotePH');
    if (rv  && rv.srcObject  !== stream) rv.srcObject  = stream;
    if (prv && prv.srcObject !== stream) prv.srcObject = stream;
    if (rph) rph.style.display = stream ? 'none' : 'flex';
  }

  // ── Layout transitions ─────────────────────────────────────────────────────
  function setLayout(mode, sharer = 'mine') {
    const facesView  = $('facesView');
    const screenView = $('screenView');
    const screenChip = $('screenChip');
    const zoomCtrls  = $('zoomControls');
    const fsBtn      = $('viewerFullscreenBtn');

    if (mode === 'faces') {
      if (facesView)  facesView.style.display  = 'grid';
      if (screenView) screenView.style.display = 'none';
      if (fsBtn)      fsBtn.style.display      = 'none';
    } else {
      if (facesView)  facesView.style.display  = 'none';
      if (screenView) screenView.style.display = 'flex';
      const isMine = sharer === 'mine';
      if (screenChip) screenChip.textContent = isMine ? '🖥️ YOUR SCREEN' : "🖥️ COUSIN'S SCREEN";
      if (zoomCtrls)  zoomCtrls.style.display = isMine ? 'none' : 'flex';
      if (fsBtn)      fsBtn.style.display     = 'flex';
    }
  }

  function applyZoom() {
    const sv = $('screenVideo');
    if (!sv) return;
    sv.style.width = `${screenZoom * 100}%`;
    sv.style.height = `${screenZoom * 100}%`;
    sv.style.objectFit = screenZoom > 1 ? 'cover' : 'contain';
    const parent = sv.parentElement;
    if (parent) parent.style.overflow = screenZoom > 1 ? 'auto' : 'hidden';
  }

  // ── Window registration with background ───────────────────────────────────
  function registerWithBackground() {
    chrome.windows.getCurrent((win) => {
      _myWindowId = win?.id ?? null;
      if (_myWindowId !== null) {
        chrome.runtime.sendMessage({ type: 'REGISTER_POPUP', windowId: _myWindowId });
      }
    });
  }

  function focusThisWindow() {
    if (_myWindowId !== null) {
      chrome.windows.update(_myWindowId, { focused: true });
    } else {
      chrome.runtime.sendMessage({ type: 'FOCUS_POPUP' });
    }
  }

  // ── INIT ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      registerWithBackground();
      verifyConfig();
      signaling = new Signaling();
      pip.init({
        floatingCamEl:        $('floatingCam'),
        floatingCamVideoEl:   $('floatingCamVideo'),
        popoutButtonEl:       $('floatingCamPopout'),
      });
      pip.onDocPipClosed((stream) => {
        // PiP closed by user — fall back to floating cam if a screen share is still active
        if (stream && (isSharingScreen || _remoteIsScreenSharing)) {
          pip.showFloating(stream);
        }
      });
      bindUI();
      await acquireLocalMedia();
    } catch (err) {
      log.error('Init error:', err);
      logUI('Initialization failed');
    }
  });

  function verifyConfig() {
    const url = window.CW_CONFIG?.firebaseDatabaseUrl;
    if (!url || url.includes('YOUR-PROJECT')) {
      showToast('⚠️ Firebase not configured — see README → Firebase Configuration', 8000);
      log.error('Firebase URL is the placeholder. Edit lib/config.js.');
    }
  }

  // ── Acquire local cam/mic with friendly error handling ────────────────────
  async function acquireLocalMedia() {
    try {
      const { stream, hasVideo, hasAudio } = await media.acquireLocalStream();
      setLocalStream(stream);
      videoEnabled = hasVideo;
      audioEnabled = hasAudio;
      logUI(hasVideo ? 'Camera ready' : (hasAudio ? 'Mic ready (no camera)' : 'Ready'));
    } catch (err) {
      if (err.message === 'media-permission-denied') {
        showToast('Need Camera / Mic access');
        logUI('Camera/mic permission denied');
      } else {
        showToast('Could not access camera/mic');
        log.error('acquireLocalMedia:', err);
      }
    }
  }

  // ── Bind every UI control once ────────────────────────────────────────────
  function bindUI() {
    $('connectBtn')   ?.addEventListener('click', connect);
    $('copyRoomBtn')  ?.addEventListener('click', copyRoom);
    $('disconnectBtn')?.addEventListener('click', disconnect);
    $('hangupBtn')    ?.addEventListener('click', hangup);
    $('toggleVideo')  ?.addEventListener('click', toggleVideo);
    $('toggleAudio')  ?.addEventListener('click', toggleAudio);
    $('shareScreen')  ?.addEventListener('click', toggleScreenShare);

    $('zoomInBtn') ?.addEventListener('click', () => { screenZoom = Math.min(4, screenZoom + 0.25); applyZoom(); });
    $('zoomOutBtn')?.addEventListener('click', () => { screenZoom = Math.max(1, screenZoom - 0.25); applyZoom(); });
    $('zoomReset') ?.addEventListener('click', () => { screenZoom = 1; applyZoom(); });

    const fsBtn = $('viewerFullscreenBtn');
    if (fsBtn) {
      fsBtn.addEventListener('click', async () => {
        const wrap = document.querySelector('.screen-main');
        if (!wrap) return;
        try {
          if (wrap.requestFullscreen)            await wrap.requestFullscreen();
          else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
        } catch (e) { log.warn('Fullscreen failed', e); }
      });
    }

    document.addEventListener('fullscreenchange', () => {
      const fs = $('viewerFullscreenBtn');
      const fc = $('floatingCam');
      if (document.fullscreenElement) {
        if (fs) fs.style.display = 'none';
        // Hide floating cam in fullscreen if PiP is showing the face
        if (fc && pip.hasDocPip) fc.style.display = 'none';
      } else {
        if (fs) fs.style.display = 'flex';
        // Restore floating cam if a screen share is still active and no PiP is open
        if (fc && (isSharingScreen || _remoteIsScreenSharing) && !pip.hasDocPip && pip.state === 'floating') {
          fc.style.display = 'block';
        }
      }
    });

    initFloatingCamDrag();
  }

  // ── CONNECT ───────────────────────────────────────────────────────────────
  async function connect() {
    if (!media.localStream || !media.localStream.active) {
      await acquireLocalMedia();
      if (!media.localStream) return;
    }

    const localStream = media.localStream;
    const roomInputEl = $('roomInput');
    const roomId = roomInputEl ? roomInputEl.value.trim().toUpperCase() : '';
    const connectBtn = $('connectBtn');

    setStatus('connecting');
    if (connectBtn) connectBtn.disabled = true;

    // Quick syntactic check — accept any CW- prefix; real verification is server-side
    if (roomId && (!roomId.startsWith('CW-') || roomId.length < 9)) {
      showToast('Invalid Room ID — should look like CW-ABC123');
      if (connectBtn) connectBtn.disabled = false;
      setStatus('offline');
      return;
    }

    // Pre-flight: don't even try if we know we're offline / Firebase unreachable
    const diag = await network.diagnose();
    if (!diag.healthy) {
      showToast(diag.message || 'Network unavailable');
      if (connectBtn) connectBtn.disabled = false;
      setStatus('offline');
      return;
    }

    // ── Wire up ICE timeout — only fires after a real diagnosis ──
    clearTimeout(_iceTimeoutTimer);
    _iceTimeoutTimer = setTimeout(async () => {
      if (isConnected) return;
      // Don't fire blindly — re-diagnose. Only show the toast if we actually
      // detect a problem. This eliminates v13's false "check your internet"
      // warnings on slow-but-healthy networks.
      const d = await network.diagnose();
      if (!d.healthy) {
        showToast(d.message || 'Could not establish connection.');
      } else {
        log.info('ICE slow but network healthy — staying quiet');
      }
    }, window.CW_CONFIG?.iceConnectTimeoutMs ?? 25000);

    // Data channel messages
    signaling.onData = (data) => {
      if      (data.type === 'SCREEN_START')   onRemoteScreenStart();
      else if (data.type === 'SCREEN_STOP')    onRemoteScreenStop();
      else if (data.type === 'SCREEN_REQUEST') onRemoteScreenRequest(data.peerId);
      else if (data.type === 'SCREEN_GRANT')   onRemoteScreenGrant();
      else if (data.type === 'SCREEN_DENY')    onRemoteScreenDeny();
      else if (data.type === 'SCREEN_CANCEL')  onRemoteScreenCancel();
    };

    if (!roomId) {
      await connectAsHost(localStream);
    } else {
      await connectAsGuest(localStream, roomId);
    }
  }

  async function connectAsHost(localStream) {
    const connectBtn = $('connectBtn');
    const myId = 'CW-' + window.CWGenerateRoomId();

    try {
      await signaling.initWithId(myId);
    } catch (err) {
      log.error('Host peer failed:', err);
      showToast('Could not create room — try again');
      if (connectBtn) connectBtn.disabled = false;
      setStatus('offline');
      clearTimeout(_iceTimeoutTimer);
      return;
    }

    const roomEl  = $('roomIdDisplay');
    const joinRow = $('joinRow');
    const roomRow = $('roomIdRow');
    if (roomEl)  roomEl.textContent = myId;
    if (joinRow) joinRow.style.display = 'none';
    if (roomRow) roomRow.style.display = 'block';
    logUI(`Hosting room ${myId}. Waiting for cousin…`);
    showToast('Room created — share your ID!');

    signaling.onCall = (mediaConn) => {
      logUI('Guest connected — answering…');
      rtc = new WebRTCClient({
        mediaConn,
        onTrack: handleRemoteTrack,
        onConnectionState: handleConnectionState,
      });
      rtc.onBitrateLog = (msg) => logUI(msg);
      rtc.onIceState(handleIceState);
      rtc.answer(localStream);
    };
  }

  async function connectAsGuest(localStream, roomId) {
    const connectBtn = $('connectBtn');

    try {
      await signaling.initAndJoin(roomId);
    } catch (err) {
      log.error('Guest peer failed:', err);
      showToast('Could not reach that room — check the ID and try again');
      if (connectBtn) connectBtn.disabled = false;
      setStatus('offline');
      clearTimeout(_iceTimeoutTimer);
      return;
    }

    const joinRow = $('joinRow');
    const roomRow = $('roomIdRow');
    const roomEl  = $('roomIdDisplay');
    if (joinRow) joinRow.style.display = 'none';
    if (roomRow) roomRow.style.display = 'block';
    if (roomEl)  roomEl.textContent = roomId;
    logUI(`Joining room ${roomId}…`);
    showToast('Joining call…');

    signaling.startGuestCall(localStream, (mediaConn) => {
      rtc = new WebRTCClient({
        mediaConn,
        onTrack: handleRemoteTrack,
        onConnectionState: handleConnectionState,
      });
      rtc.onBitrateLog = (msg) => logUI(msg);
      rtc.onIceState(handleIceState);
    });
  }

  function handleConnectionState(state) {
    logUI('Connection: ' + state);
    if (state === 'connected') {
      setStatus('connected');
      isConnected = true;
      clearTimeout(_iceTimeoutTimer);
      const hb = $('hangupBtn');
      if (hb) hb.style.display = 'flex';
      rtc?.startAdaptiveBitrate(isSharingScreen);
      showToast('🎉 Connected to your cousin!');
    } else if (['disconnected', 'failed', 'closed'].includes(state)) {
      setStatus('offline');
      isConnected = false;
    } else if (state === 'connecting') {
      setStatus('connecting');
    }
  }

  function handleIceState(state) {
    if (state === 'connected' || state === 'completed') {
      clearTimeout(_iceTimeoutTimer);
      setStatus('connected');
      isConnected = true;
    } else if (state === 'failed') {
      setStatus('offline');
      showToast('⚠️ Connection failed. Try leaving and rejoining.');
    } else if (state === 'disconnected') {
      setStatus('connecting');
    }
  }

  // ── Remote tracks ──────────────────────────────────────────────────────────
  function handleRemoteTrack(track, stream) {
    if (!stream || track.readyState === 'ended') return;
    log.debug('remote track:', track.kind, 'stream:', stream?.id);

    if (track.kind === 'video') {
      if (_remoteIsScreenSharing) {
        const sv = $('screenVideo');
        if (sv && sv.srcObject !== stream) {
          sv.srcObject = stream;
          sv.muted = false;
        }
      } else {
        setRemoteStream(stream);
      }
    } else if (track.kind === 'audio') {
      const rv  = $('remoteVideo');
      const prv = $('pipRemoteVideo');
      const existing = rv?.srcObject;
      if (!existing) {
        setRemoteStream(stream);
      } else {
        const already = existing.getAudioTracks().some(t => t.id === track.id);
        if (!already) existing.addTrack(track);
        if (rv && rv.srcObject !== existing) rv.srcObject = existing;
        if (prv && prv.srcObject !== existing) prv.srcObject = existing;
      }
    }
  }

  // ── Toggle video / audio ───────────────────────────────────────────────────
  function toggleVideo() {
    if (!media.localStream) return;
    const track = media.localStream.getVideoTracks()[0];
    if (!track) return;
    videoEnabled = !videoEnabled;
    track.enabled = videoEnabled;
    const btn = $('toggleVideo');
    if (btn) {
      btn.textContent = videoEnabled ? '📷' : '🚫';
      btn.className = `round-btn ${videoEnabled ? 'on' : 'off'}`;
    }
  }

  function toggleAudio() {
    if (!media.localStream) return;
    const track = media.localStream.getAudioTracks()[0];
    if (!track) return;
    audioEnabled = !audioEnabled;
    track.enabled = audioEnabled;
    const btn = $('toggleAudio');
    if (btn) {
      btn.textContent = audioEnabled ? '🎙️' : '🔇';
      btn.className = `round-btn ${audioEnabled ? 'on' : 'off'}`;
    }
    const localTile = $('localTile');
    if (localTile) localTile.classList.toggle('mic-off', !audioEnabled);
  }

  // ── Mirror-guard overlay ───────────────────────────────────────────────────
  // Shown in place of the local screen preview when a full-monitor share is
  // active. Prevents the recursive "infinite mirror" that would otherwise
  // appear when the user looks at the extension popup while it is being
  // captured and re-displayed inside itself.

  function showMirrorGuard() {
    if ($('mirrorGuard')) return;   // idempotent

    const guard = document.createElement('div');
    guard.id = 'mirrorGuard';

    // Build via createElement — keeps Trusted Types policy happy
    const icon = document.createElement('div');
    icon.className = 'mg-icon';
    icon.textContent = '🖥️';

    const title = document.createElement('div');
    title.className = 'mg-title';
    title.textContent = 'Preview hidden';

    const sub = document.createElement('div');
    sub.className = 'mg-sub';
    sub.textContent =
      'Full-screen local preview not available';

    guard.append(icon, title, sub);

    const screenMain = document.querySelector('.screen-main');
    if (screenMain) screenMain.appendChild(guard);
  }

  function hideMirrorGuard() {
    $('mirrorGuard')?.remove();
  }

  // ── Screen share ───────────────────────────────────────────────────────────
  async function toggleScreenShare() {
    if (isSharingScreen) {
      await stopScreenShare();
    } else {
      if (_remoteIsScreenSharing) {
        showToast('⛔ Your cousin is already sharing their screen');
        return;
      }
      if (_screenRequestPending) {
        showToast('⏳ Screen share request already pending…');
        return;
      }
      // Send an optimistic-lock request rather than starting immediately.
      // startScreenShare() is called only after we receive SCREEN_GRANT.
      _screenRequestPending = true;
      signaling.send({ type: 'SCREEN_REQUEST', peerId: signaling.peer?.id ?? '' });
    }
  }

  /**
   * Remote peer sent SCREEN_REQUEST — they want to share.
   * We are the arbiter: grant if no one is sharing AND we are not also
   * requesting at the same moment with a winning peer ID.
   */
  function onRemoteScreenRequest(remotePeerId) {
    const myPeerId = signaling.peer?.id ?? '';

    // If the remote is already considered sharing or we ourselves are sharing,
    // deny outright.
    if (_remoteIsScreenSharing || isSharingScreen) {
      signaling.send({ type: 'SCREEN_DENY' });
      return;
    }

    // Simultaneous-request tie-break: smaller peer ID wins.
    // If we also have a pending request, compare IDs to decide who yields.
    if (_screenRequestPending) {
      if (myPeerId < remotePeerId) {
        // We win — deny the remote's request. Our own SCREEN_GRANT will
        // arrive when the remote (now the arbiter) processes our request.
        signaling.send({ type: 'SCREEN_DENY' });
        return;
      } else {
        // Remote wins — cancel our own pending request and grant theirs.
        _screenRequestPending = false;
        showToast('⛔ Your cousin also requested — they got priority');
      }
    }

    // Grant the remote's request and mark them as sharing so our own UI
    // reflects the lock immediately, before their SCREEN_START arrives.
    _remoteIsScreenSharing = true;
    signaling.send({ type: 'SCREEN_GRANT' });
  }

  /** Remote granted our SCREEN_REQUEST — safe to start sharing now. */
  async function onRemoteScreenGrant() {
    _screenRequestPending = false;
    await startScreenShare();
  }

  /** Remote denied our SCREEN_REQUEST — someone else holds the lock. */
  function onRemoteScreenDeny() {
    _screenRequestPending = false;
    showToast('⛔ Your cousin is already sharing — request denied');
  }

  /**
   * Remote peer was granted the lock but cancelled the browser prompt.
   * Roll back _remoteIsScreenSharing so future share requests aren't blocked.
   */
  function onRemoteScreenCancel() {
    _remoteIsScreenSharing = false;
    log.info('Remote cancelled screen share prompt — lock released');
  }

  async function startScreenShare() {
    if (!rtc) {
      showToast('Not in a call');
      return;
    }
    const btn = $('shareScreen');

    // Pre-open Document PiP inside the user gesture (browser requires this).
    const pipOpened = await pip.openDocPip({ width: 320, height: 240 });

    const screenStream = await media.acquireScreenStream();
    if (!screenStream) {
      showToast('Screen share cancelled or denied');
      pip.hideAll();
      // Tell the remote peer to release the lock they granted us — without
      // this, their _remoteIsScreenSharing stays true and blocks all future
      // share attempts for the rest of the session.
      signaling.send({ type: 'SCREEN_CANCEL' });
      return;
    }

    const screenVideoTrack = screenStream.getVideoTracks()[0];
    const screenAudioTrack = screenStream.getAudioTracks()[0];

    // ── Mirror-loop guard ───────────────────────────────────────────────────
    // When sharing a full monitor the extension popup is visible on that same
    // screen. Feeding the capture stream back into #screenVideo would create
    // an infinite recursive mirror. Detect monitor shares and suppress the
    // local preview; show a static placeholder instead. Window/tab shares are
    // left as-is because they target a specific surface that is (almost) never
    // the extension popup itself.
    const displaySurface = screenVideoTrack?.getSettings?.()?.displaySurface;
    _isMonitorShare = displaySurface === 'monitor';

    const sv = $('screenVideo');
    if (sv) {
      if (_isMonitorShare) {
        sv.srcObject = null;  // keep the stream off the preview entirely
        showMirrorGuard();
        log.info('Monitor share detected — local preview suppressed to prevent infinite mirror');
      } else {
        sv.srcObject = screenStream;
        sv.muted = true;
      }
    }

    setLayout('screen', 'mine');
    isSharingScreen = true;
    if (btn) { btn.textContent = '⏹️'; btn.classList.add('active'); }

    // Black out the pip remote tile — face moves to PiP/floating cam
    const prv = $('pipRemoteVideo');
    if (prv) prv.srcObject = null;

    const remoteSnapshot = $('remoteVideo')?.srcObject || _lastGoodRemoteStream;

    // Switch outbound video to the screen track
    await rtc.startScreenShare(screenVideoTrack);
    if (isConnected) rtc.startAdaptiveBitrate(true);

    // Move webcam to the secondary slot so cousin can see sharer's face
    const camTrack = media.localStream?.getVideoTracks()[0];
    if (camTrack) await rtc.activateWebcamSlot(camTrack);

    signaling.send({ type: 'SCREEN_START' });

    // Show cousin's face in the PiP / floating cam
    if (pipOpened) {
      if (remoteSnapshot && remoteSnapshot.getVideoTracks().some(t => t.readyState !== 'ended')) {
        pip.setStream(remoteSnapshot);
      } else {
        // Wait for cousin's face stream to become live
        pip.attachWhenReady(() => $('remoteVideo')?.srcObject || _lastGoodRemoteStream);
      }
    } else {
      // Fall back to floating cam in-extension
      const stream = remoteSnapshot
                  || $('remoteVideo')?.srcObject
                  || _lastGoodRemoteStream;
      if (stream) {
        pip.showFloating(stream);
      } else {
        pip.attachWhenReady(() => $('remoteVideo')?.srcObject || _lastGoodRemoteStream);
        // attachWhenReady will set the stream when ready, but we need to make
        // floating cam visible first if PiP isn't an option
        const fc = $('floatingCam');
        if (fc) fc.style.display = 'block';
      }
    }

    // Audio mix
    if (screenAudioTrack) {
      const micTrack = media.localStream?.getAudioTracks()[0];
      const mixedTrack = await mixer.start({ micTrack, screenAudioTrack });
      if (mixedTrack) await rtc.replaceAudioTrack(mixedTrack);
      showToast('🎵 Audio captured — cousin hears your screen audio!');
    } else {
      showToast('⚠️ No audio captured. Tick "Share tab audio" in the dialog.');
    }

    screenVideoTrack.onended = () => stopScreenShare();
    focusThisWindow();
  }

  async function stopScreenShare() {
    const btn = $('shareScreen');

    // Stop the audio mixer first and put the mic back as the audio track
    await mixer.stop();
    const micTrack = media.localStream?.getAudioTracks()[0];
    if (rtc && micTrack) await rtc.replaceAudioTrack(micTrack);

    media.stopScreenStream();
    hideMirrorGuard();
    _isMonitorShare = false;

    const cameraTrack = media.localStream?.getVideoTracks()[0];
    if (rtc) {
      await rtc.stopScreenShare(cameraTrack || null);
      await rtc.deactivateWebcamSlot();
      if (isConnected) rtc.startAdaptiveBitrate(false);
    }

    pip.hideAll();
    signaling.send({ type: 'SCREEN_STOP' });

    const sv = $('screenVideo');
    if (sv) sv.srcObject = null;

    setLayout('faces');
    isSharingScreen = false;
    if (btn) { btn.textContent = '🖥️'; btn.classList.remove('active'); }
  }

  // ── Viewer side (cousin started sharing) ──────────────────────────────────
  function onRemoteScreenStart() {
    _remoteIsScreenSharing = true;
    setLayout('screen', 'theirs');
    showToast("🖥️ Cousin started screen share");

    const rv = $('remoteVideo');
    const sv = $('screenVideo');
    if (rv?.srcObject && sv) {
      sv.srcObject = rv.srcObject;
      sv.muted = false;
      rv.muted = true;
    }

    // Clear remote pip tile and show "screen" label
    const prv = $('pipRemoteVideo');
    if (prv) prv.srcObject = null;
    const pipRemoteTile = $('pipRemoteTile');
    if (pipRemoteTile) {
      let lbl = pipRemoteTile.querySelector('.pip-screen-label');
      if (!lbl) {
        lbl = document.createElement('div');
        lbl.className = 'pip-screen-label';
        // Build via createElement (no innerHTML) — keeps trusted-types friendly
        const icon = document.createElement('span');
        icon.style.fontSize = '1.1rem';
        icon.textContent = '🖥️';
        const text = document.createElement('span');
        text.style.fontSize = '0.65rem';
        text.style.fontWeight = '700';
        text.style.letterSpacing = '0.5px';
        text.textContent = 'SCREEN';
        lbl.append(icon, text);
        pipRemoteTile.appendChild(lbl);
      }
      lbl.style.display = 'flex';
    }

    showViewerPip();
  }

  function onRemoteScreenStop() {
    _remoteIsScreenSharing = false;

    const sv = $('screenVideo');
    const rv = $('remoteVideo');
    if (sv) { sv.srcObject = null; sv.muted = true; }
    if (rv) rv.muted = false;

    setLayout('faces');
    showToast("🖥️ Screen share ended");

    pip.hideAll();

    const pipRemoteTile = $('pipRemoteTile');
    if (pipRemoteTile) {
      const lbl = pipRemoteTile.querySelector('.pip-screen-label');
      if (lbl) lbl.style.display = 'none';
    }

    // Recover remote video stream into the faces view
    if (rtc?.pc) {
      const receivers = rtc.pc.getReceivers();
      const videoTrack = receivers.find(r => r.track?.kind === 'video')?.track;
      if (videoTrack) {
        const stream = new MediaStream([videoTrack]);
        receivers.filter(r => r.track?.kind === 'audio').forEach(r => stream.addTrack(r.track));
        setRemoteStream(stream);
      }
    }
  }

  // Viewer: show cousin's face in the floating cam, offer to pop out via toast
  function showViewerPip() {
    const tryAttach = (attemptsLeft) => {
      if (!_remoteIsScreenSharing) return;

      const receiver = rtc?.getWebcamReceiver?.();
      const track = receiver?.track;
      if (track && track.readyState !== 'ended') {
        const stream = new MediaStream([track]);
        pip.showFloating(stream);
        showViewerPipToast();
        return;
      }
      if (attemptsLeft > 0) setTimeout(() => tryAttach(attemptsLeft - 1), 400);
    };
    tryAttach(20);
  }

  function showViewerPipToast() {
    const existing = $('cw-pip-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'cw-pip-toast';

    // Build the toast contents WITHOUT innerHTML
    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = '👤';

    const text = document.createElement('div');
    text.className = 'toast-text';
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = "Pop out cousin's face";
    const sub = document.createElement('div');
    sub.className = 'toast-sub';
    sub.textContent = 'Click to open in Picture-in-Picture';
    text.append(title, sub);

    toast.append(icon, text);

    toast.addEventListener('click', async () => {
      toast.remove();
      // pip already has the stream from showFloating; opening docpip migrates it
      await pip.openDocPip({ width: 320, height: 240, stream: pip._currentStream });
    });

    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
  }

  // ── Hangup / disconnect / cleanup ─────────────────────────────────────────
  function copyRoom() {
    const el = $('roomIdDisplay');
    if (!el) return;
    const id = el.textContent;
    if (!id || id === '—') return;
    navigator.clipboard.writeText(id)
      .then(() => showToast('📋 ID Copied!'))
      .catch(() => showToast('Copy failed'));
  }

  function hangup() {
    if (!rtc) return;
    rtc.close();
    rtc = null;
    setRemoteStream(null);
    _lastGoodRemoteStream = null;
    const hb = $('hangupBtn');
    if (hb) hb.style.display = 'none';
    setStatus('connecting');
    isConnected = false;
    showToast('📵 Hung up — still in room');
  }

  function disconnect() {
    cleanup();
    showToast('👋 Left the room');
  }

  function cleanup() {
    if (isSharingScreen) {
      // Best-effort — don't await, cleanup must be synchronous-feeling
      stopScreenShare().catch(e => log.warn('stopScreenShare during cleanup:', e));
    }
    mixer.stop().catch(() => {});
    clearTimeout(_iceTimeoutTimer);

    if (rtc) { rtc.close(); rtc = null; }
    if (signaling) {
      signaling.destroy();
      signaling = new Signaling();
    }

    media.stopAll();
    pip.hideAll();

    isConnected = false;
    isSharingScreen = false;
    _remoteIsScreenSharing = false;
    _screenRequestPending = false;
    _lastGoodRemoteStream = null;

    setLocalStream(null);
    setRemoteStream(null);
    const sv = $('screenVideo');
    if (sv) sv.srcObject = null;

    const joinRow = $('joinRow');
    const roomRow = $('roomIdRow');
    const connBtn = $('connectBtn');
    const hangupBtn = $('hangupBtn');
    if (joinRow)   joinRow.style.display   = 'flex';
    if (roomRow)   roomRow.style.display   = 'none';
    if (connBtn)   connBtn.disabled        = false;
    if (hangupBtn) hangupBtn.style.display = 'none';

    setStatus('offline');
    setLayout('faces');
    logUI('Disconnected');
  }

  // Final unload cleanup — frees the PiP and any open streams
  window.addEventListener('beforeunload', () => {
    try {
      pip.destroy();
      mixer.stop().catch(() => {});
      if (rtc) rtc.close();
      if (signaling) signaling.destroy();
      media.stopAll();
    } catch (_) {}
  });

  // ── Floating cam drag + resize ────────────────────────────────────────────
  function initFloatingCamDrag() {
    const floatingCam = $('floatingCam');
    const floatingCamResize = $('floatingCamResize');
    if (!floatingCam) return;

    let _drag = null;
    let _resize = null;
    const MIN_W = 80, MIN_H = 55;

    floatingCam.addEventListener('mousedown', (e) => {
      if (e.target === floatingCamResize) return;
      e.preventDefault();
      const rect = floatingCam.getBoundingClientRect();
      const parent = floatingCam.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
      floatingCam.style.left = (rect.left - parent.left) + 'px';
      floatingCam.style.top  = (rect.top  - parent.top ) + 'px';
      floatingCam.style.right = '';
      floatingCam.style.bottom = '';
      _drag = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left - parent.left,
        origTop:  rect.top  - parent.top,
      };
      floatingCam.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
      if (_drag) {
        const parent = floatingCam.offsetParent;
        if (!parent) return;
        const pRect = parent.getBoundingClientRect();
        const dx = e.clientX - _drag.startX;
        const dy = e.clientY - _drag.startY;
        const newLeft = Math.max(0, Math.min(_drag.origLeft + dx, pRect.width  - floatingCam.offsetWidth));
        const newTop  = Math.max(0, Math.min(_drag.origTop  + dy, pRect.height - floatingCam.offsetHeight));
        floatingCam.style.left = newLeft + 'px';
        floatingCam.style.top  = newTop  + 'px';
      }
      if (_resize) {
        const dx = e.clientX - _resize.startX;
        const dy = e.clientY - _resize.startY;
        floatingCam.style.width  = Math.max(MIN_W, _resize.origW + dx) + 'px';
        floatingCam.style.height = Math.max(MIN_H, _resize.origH + dy) + 'px';
      }
    });

    document.addEventListener('mouseup', () => {
      if (_drag) { _drag = null; floatingCam.classList.remove('dragging'); }
      _resize = null;
    });

    if (floatingCamResize) {
      floatingCamResize.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _resize = {
          startX: e.clientX,
          startY: e.clientY,
          origW: floatingCam.offsetWidth,
          origH: floatingCam.offsetHeight,
        };
      });
    }
  }
})();
