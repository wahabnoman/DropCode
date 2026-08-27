(() => {
  'use strict';

  const CHUNK_SIZE = 16 * 1024; // 16KB - safe across browsers
  const BUFFERED_AMOUNT_LOW_THRESHOLD = 1 * 1024 * 1024; // 1MB
  const BUFFERED_AMOUNT_HIGH_WATERMARK = 8 * 1024 * 1024; // 8MB - pause sending above this

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // If a direct WebRTC connection hasn't opened within this long, assume
  // something is blocking it (a VPN client or a firewall commonly block
  // WebRTC outright) and fall back to relaying that connection's data
  // through the server instead. Overridable for testing via
  // window.__DROPCODE_FALLBACK_MS.
  const WEBRTC_FALLBACK_MS = window.__DROPCODE_FALLBACK_MS ?? 6000;

  // How many files stream their actual bytes at once. Offers/accepts for
  // many files still happen immediately and concurrently - this only caps
  // how many are pulling bytes through the network at the same time, so a
  // pile of files doesn't fight itself for one connection's bandwidth.
  const MAX_CONCURRENT_STREAMS = window.__DROPCODE_MAX_STREAMS ?? 3;

  // How long to wait for a device to answer "how much of this file do you
  // already have" before just resuming from scratch.
  const RESUME_QUERY_TIMEOUT_MS = 8000;
  // Reconnect backoff cap - retries keep happening but never slower than this.
  const RECONNECT_MAX_DELAY_MS = 15000;

  // ---------- session persistence (survive a page refresh) ----------
  // sessionStorage (not localStorage) on purpose: it clears when the tab
  // actually closes, so a stale session from days ago never auto-resumes.
  const SESSION_KEY = 'dropcode-session';
  function saveSession(data) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (e) {}
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  // Your device's display name persists in localStorage (unlike the
  // session above, this is meant to survive across visits, not just a
  // reload) so you don't have to retype it every time.
  const NAME_KEY = 'dropcode-name';
  function loadName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) {}
  }

  // This tab's own stable identity. Everything else in the app (room
  // membership, targets, in-flight transfer bookkeeping) is keyed on this,
  // NOT on socket.id - socket.id changes every time the connection drops
  // and reconnects, which would otherwise make a device look like a total
  // stranger after a brief network blip and make "resume" impossible.
  // sessionStorage (not localStorage): survives a reload of this tab, but
  // two tabs on the same machine still get distinct identities.
  const CLIENT_ID_KEY = 'dropcode-client-id';
  function getClientId() {
    try {
      let id = sessionStorage.getItem(CLIENT_ID_KEY);
      if (!id) {
        id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(CLIENT_ID_KEY, id);
      }
      return id;
    } catch (e) {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }
  const myClientId = getClientId();
  const myId = () => myClientId;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const setupPanel = $('setup');
  const sessionPanel = $('session');
  const myNameInput = $('myNameInput');
  const hostBtn = $('hostBtn');
  const hostInfo = $('hostInfo');
  const codeDisplay = $('codeDisplay');
  const linkDisplay = $('linkDisplay');
  const copyCodeBtn = $('copyCodeBtn');
  const copyLinkBtn = $('copyLinkBtn');
  const codeInput = $('codeInput');
  const joinBtn = $('joinBtn');
  const setupError = $('setupError');
  const hostForceRelay = $('hostForceRelay');
  const joinForceRelay = $('joinForceRelay');

  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const myNameInputSession = $('myNameInputSession');
  const renameBtn = $('renameBtn');
  const deviceList = $('deviceList');
  const disconnectBtn = $('disconnectBtn');
  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const folderInput = $('folderInput');
  const pickFilesBtn = $('pickFilesBtn');
  const pickFolderBtn = $('pickFolderBtn');
  const textInput = $('textInput');
  const sendTextBtn = $('sendTextBtn');
  const textLog = $('textLog');
  const transferList = $('transferList');

  myNameInput.value = loadName();

  function currentName() {
    return (myNameInput.value || myNameInputSession.value || '').trim().slice(0, 40);
  }

  // ---------- state ----------
  const socket = io();
  let role = null; // 'host' | 'peer'
  let hostClientId = null; // for a peer: the host's stable id (its one connection)
  let currentCode = null; // the room code we're currently in, if any
  let intentionalDisconnect = false;
  let hasEverConnected = false;
  let saveDirHandle = null; // File System Access API directory handle, if chosen

  // clientId -> connection state. Keyed by the STABLE id, not a transport
  // socket id, so a device that blips and reconnects is recognized as the
  // same connection (and can resume) instead of orphaning everything and
  // starting over. `socketId` is the live transport target for signaling -
  // it's updated whenever the remote side reconnects; `pc`/`channel` are
  // the actual WebRTC bits (webrtc mode) and carry both small JSON control
  // messages and 1-byte-slot-framed binary chunks over one ordered channel
  // (two channels on one connection have no ordering guarantee *between*
  // them, so a chunk could arrive before the message describing it).
  const connections = new Map();
  const retryCounts = new Map(); // clientId -> consecutive failed reconnect attempts (survives conn recreation)

  // fileId -> receive state; connId -> Map(slot -> fileId) for whatever's
  // actively streaming in on that connection right now (the 1-byte slot
  // lets several files stream over the same connection at once).
  const incoming = new Map();
  const activeReceiveBySlot = new Map();
  // fileId -> { row } for an offer this device hasn't accepted/declined yet.
  const pendingIncoming = new Map();
  // fileId -> { targets, responded: Set, accepted: Set, resolve } - sender side.
  // ponytail: no timeout and no cleanup on a targeted device disconnecting
  // mid-wait, so a send can hang forever waiting on a response that will
  // never come. Add a timeout (treat as decline) if this bites someone.
  const pendingOffers = new Map();
  // Host only: connId -> Map(sourceSlot -> [{clientId, slot}]) - which of
  // this connection's active incoming streams should be mirrored onward to
  // which other connections (each with its OWN slot number, since a slot
  // is only meaningful within one connection's own namespace).
  const relayRoutes = new Map();
  // fileId -> { file, name, path, size, row, targets: Map(clientId -> {offset, stalled, done, wireClientId, pendingTargets}) }
  const outgoing = new Map();
  // "fileId:responderId" -> resolve(receivedBytes|null) - sender side, for
  // the resume handshake (see queryOneResume / the file-resume-ack handler).
  const resumeQueries = new Map();

  let activeStreams = 0;
  const streamWaiters = [];
  function acquireStreamSlot() {
    return new Promise((resolve) => {
      if (activeStreams < MAX_CONCURRENT_STREAMS) { activeStreams++; resolve(); }
      else streamWaiters.push(resolve);
    });
  }
  function releaseStreamSlot() {
    const next = streamWaiters.shift();
    if (next) next();
    else activeStreams--;
  }

  let deviceCounter = 0;
  // Everyone currently in the room, from the server's 'roster' broadcast.
  let roster = [];
  const deviceNames = new Map(); // id -> chosen display name
  const nameFor = (id) => {
    if (deviceNames.has(id)) return deviceNames.get(id);
    return connections.has(id) ? connections.get(id).label : 'a device';
  };

  // ---------- helpers ----------
  function showError(msg) {
    setupError.textContent = msg;
    setupError.classList.remove('hidden');
  }
  function clearError() {
    setupError.classList.add('hidden');
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function openConnectionCount() {
    let n = 0;
    for (const c of connections.values()) if (c.ready) n++;
    return n;
  }

  function refreshStatus() {
    const n = openConnectionCount();
    if (n === 0) {
      setStatus(false, role === 'host' ? 'Waiting for a device to connect...' : 'Connecting...');
    } else if (role === 'host') {
      setStatus(true, `Connected — ${n} device${n === 1 ? '' : 's'} in this session.`);
    } else {
      const conn = connections.get(hostClientId);
      const relayed = conn?.mode === 'relay';
      setStatus(true, `Connected to host${relayed ? ' (relayed via server)' : ''} — ready to send files, folders, or text.`);
    }
    renderDeviceList();
  }

  // Renders every other device in the room as a checkable pill - this
  // doubles as the "who should receive this" target picker. Checked by
  // default, so leaving them alone sends to everyone, same as before.
  function renderDeviceList() {
    const others = roster.filter((d) => d.id !== myId());
    if (!others.length) {
      deviceList.innerHTML = '<p class="hint">No other devices yet.</p>';
      return;
    }
    deviceList.innerHTML = others
      .map((d) => {
        const conn = connections.get(d.id);
        const relayed = conn?.mode === 'relay' ? ' · relayed' : '';
        const reconnecting = conn && !conn.ready ? ' · reconnecting…' : '';
        return `<label class="device-pill">
          <input type="checkbox" class="target-check" data-id="${d.id}" checked />
          <span>${escapeHtml(d.name || 'Device')}${d.isHost ? ' (host)' : ''}${relayed}${reconnecting}</span>
        </label>`;
      })
      .join('');
  }

  // Which device ids the next send should go to. No boxes checked would
  // mean "send to nobody", which is never useful, so that case falls back
  // to everyone instead.
  function getSelectedTargets() {
    const boxes = [...deviceList.querySelectorAll('.target-check')];
    if (!boxes.length) return [];
    const checked = boxes.filter((b) => b.checked).map((b) => b.dataset.id);
    return checked.length ? checked : boxes.map((b) => b.dataset.id);
  }

  function setStatus(connected, text) {
    statusDot.classList.toggle('connected', connected);
    statusText.textContent = text;
  }

  function enterSession() {
    setupPanel.classList.add('hidden');
    sessionPanel.classList.remove('hidden');
    myNameInputSession.value = currentName();
  }

  // ---------- shareable link ----------
  // NOT window.location.href: if the host happened to open the page via
  // "localhost" (or any address other than the one on the LAN), that would
  // be meaningless to share - a friend's "localhost" means their own
  // machine, not the host's. Ask the server what address it actually
  // detected instead (same logic the console printout uses).
  let networkInfo = null;
  async function getShareableLink() {
    if (!networkInfo) {
      try {
        networkInfo = await fetch('/api/network-info').then((r) => r.json());
      } catch (e) {
        networkInfo = {};
      }
    }
    if (networkInfo.address) {
      return `http://${networkInfo.address}:${networkInfo.port}/`;
    }
    return window.location.href.split('?')[0]; // best-effort fallback
  }

  // ---------- signaling / role setup ----------
  function onHosting(code) {
    role = 'host';
    currentCode = code;
    hostInfo.classList.remove('hidden');
    hostBtn.disabled = true;
    codeDisplay.textContent = code;
    getShareableLink().then((link) => { linkDisplay.textContent = link; });
    setStatus(false, 'Waiting for a device to connect...');
    enterSession();
    saveSession({ role: 'host', code });
  }

  hostBtn.addEventListener('click', () => {
    clearError();
    saveName(currentName());
    socket.emit('host-start', myClientId, currentName(), ({ code }) => onHosting(code));
  });

  copyCodeBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(codeDisplay.textContent).catch(() => {});
  });
  copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(linkDisplay.textContent).catch(() => {});
  });

  function doJoin(code, onFail) {
    socket.emit('join-room', code, myClientId, currentName(), (res) => {
      if (res.error) return onFail ? onFail(res.error) : showError(res.error);
      role = 'peer';
      hostClientId = res.hostClientId;
      currentCode = code;
      setStatus(false, 'Connecting...');
      enterSession();
      saveSession({ role: 'peer', code });
      if (res.hostSocketId) {
        ensureConnection(hostClientId, res.hostSocketId, false, 'Host', joinForceRelay.checked ? 0 : WEBRTC_FALLBACK_MS);
        refreshStatus();
      }
    });
  }

  joinBtn.addEventListener('click', () => {
    clearError();
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return showError('Enter a code first.');
    saveName(currentName());
    doJoin(code);
  });

  // Pre-fill code from ?code=XXXXXX if present
  const urlCode = new URLSearchParams(window.location.search).get('code');
  if (urlCode) codeInput.value = urlCode.toUpperCase();

  // Rename mid-session: tell the server, which broadcasts the updated
  // roster to everyone (including yourself) so labels update everywhere.
  renameBtn.addEventListener('click', () => {
    const n = myNameInputSession.value.trim().slice(0, 40);
    if (!n) return;
    saveName(n);
    socket.emit('rename', n);
  });

  // Reconcile the host's connections against a fresh peer list from the
  // server (used both for the very first host-resume-after-reload and for
  // a plain reconnect after a network blip). Peers no longer in the list
  // truly left while we were gone; everyone else gets ensureConnection,
  // which is a no-op for a connection that's already fine.
  function reconcileHostPeers(peers) {
    const liveIds = new Set(peers.map((p) => p.clientId));
    for (const cid of [...connections.keys()]) {
      if (!liveIds.has(cid)) closeConnection(cid);
    }
    for (const p of peers) {
      ensureConnection(p.clientId, p.socketId, true, nameFor(p.clientId), hostForceRelay.checked ? 0 : WEBRTC_FALLBACK_MS);
    }
    refreshStatus();
  }

  function attemptResume(saved) {
    if (saved.role === 'host') {
      socket.emit('host-resume', saved.code, myClientId, currentName(), (res) => {
        if (res.ok) {
          onHosting(res.code);
          reconcileHostPeers(res.peers);
        } else {
          clearSession(); // code expired - just leave them at the normal setup screen
        }
      });
    } else if (saved.role === 'peer') {
      doJoin(saved.code, () => clearSession());
    }
  }

  socket.on('connect', () => {
    if (!hasEverConnected) {
      hasEverConnected = true;
      const saved = loadSession();
      if (saved) attemptResume(saved);
      return;
    }
    // A reconnect after a genuine drop (network blip, dev server restart,
    // laptop sleep/wake) - not a page reload. Silently rejoin under the
    // new socket id using the identity/role we already have in memory, so
    // relay-mode connections (which tunnel through this very socket) come
    // back instead of just looking dead forever.
    if (intentionalDisconnect || !currentCode) return;
    if (role === 'host') {
      socket.emit('host-resume', currentCode, myClientId, currentName(), (res) => {
        if (res.ok) reconcileHostPeers(res.peers);
        // If !res.ok, the room's grace window lapsed while we were
        // disconnected - 'host-left' (below) will have already fired.
      });
    } else if (role === 'peer') {
      socket.emit('join-room', currentCode, myClientId, currentName(), (res) => {
        if (res.error) return;
        hostClientId = res.hostClientId;
        if (res.hostSocketId) ensureConnection(hostClientId, res.hostSocketId, false, 'Host', joinForceRelay.checked ? 0 : WEBRTC_FALLBACK_MS);
        refreshStatus();
      });
    }
  });

  // The signaling socket itself dropped. A relay-mode connection tunnels
  // through it directly, so pause (not abandon) those - the reconnect
  // handler above will mark them ready again once we're back. A WebRTC
  // connection that's already established doesn't depend on this socket at
  // all and is unaffected; its own ICE state drives its own recovery.
  socket.on('disconnect', () => {
    for (const conn of connections.values()) {
      if (conn.mode === 'relay') conn.ready = false;
    }
    refreshStatus();
  });

  // The room's current device list (id, name, host flag) - drives naming
  // and the "send to" target picker everywhere.
  socket.on('roster', (list) => {
    roster = list;
    deviceNames.clear();
    for (const d of list) deviceNames.set(d.id, d.name);
    renderDeviceList();
  });

  // A new peer joined (host only), or an existing one rejoined after a
  // blip under a fresh socket id - either way, ensureConnection sorts out
  // which.
  socket.on('peer-joined', ({ peerClientId, peerSocketId }) => {
    if (role !== 'host') return;
    deviceCounter += 1;
    ensureConnection(peerClientId, peerSocketId, true, `Device ${deviceCounter}`, hostForceRelay.checked ? 0 : WEBRTC_FALLBACK_MS);
    refreshStatus();
  });

  // One peer left for good (host only): tear down that connection.
  socket.on('peer-left', ({ peerClientId }) => {
    closeConnection(peerClientId);
    refreshStatus();
  });

  // The host dropped (reload, blip, or real disconnect) - not necessarily
  // final. It has a window to come back before the session actually ends
  // (see 'host-left' below). Pause our connection to it rather than
  // abandoning it, so any in-flight transfer can resume once it's back.
  socket.on('host-disconnected', () => {
    const conn = hostClientId && connections.get(hostClientId);
    if (conn) conn.ready = false;
    setStatus(false, 'Host disconnected — waiting for it to reconnect...');
  });

  // The host came back within its reconnect window (peer only).
  socket.on('host-reconnected', ({ hostClientId: hcid, hostSocketId }) => {
    if (role !== 'peer') return;
    hostClientId = hcid;
    ensureConnection(hostClientId, hostSocketId, false, 'Host', joinForceRelay.checked ? 0 : WEBRTC_FALLBACK_MS);
    refreshStatus();
  });

  // The host's reconnect window ran out (or it disconnected for good).
  socket.on('host-left', () => {
    setStatus(false, 'The host ended the session.');
    for (const id of [...connections.keys()]) closeConnection(id);
    outgoing.clear();
    incoming.clear();
    currentCode = null;
    clearSession();
  });

  socket.on('signal', async (data) => {
    const fromClientId = data.fromClientId;
    const fromSocketId = data.from;
    if (!fromClientId) return;

    let conn = connections.get(fromClientId);
    if (conn) conn.socketId = fromSocketId; // keep "where to reach them" current regardless of path below

    if (data.type === 'offer' && (!conn || !conn.pc || ['closed', 'failed'].includes(conn.pc.connectionState))) {
      // Fresh negotiation - either first contact, or the old one is dead.
      // Recreating preserves outgoing/incoming state (keyed by clientId,
      // untouched by this), so an in-flight transfer can still resume.
      if (conn) closeConnection(fromClientId, { keepTransferState: true });
      conn = createConnection(fromClientId, false, role === 'peer' ? 'Host' : nameFor(fromClientId), (role === 'peer' ? joinForceRelay : hostForceRelay).checked ? 0 : WEBRTC_FALLBACK_MS, fromSocketId);
    } else if (!conn) {
      return; // an answer/ice for a connection we don't recognize - nothing to do
    }

    if (conn.mode === 'relay') return; // already gave up on WebRTC for this connection
    try {
      if (data.type === 'offer') {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await conn.pc.createAnswer();
        await conn.pc.setLocalDescription(answer);
        socket.emit('signal', { to: conn.socketId, type: 'answer', sdp: answer });
      } else if (data.type === 'answer') {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'ice' && data.candidate) {
        try { await conn.pc.addIceCandidate(data.candidate); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.error('Signaling error', e);
    }
  });

  // ---------- WebRTC (with a same-server relay fallback) ----------
  // Every connection starts in 'webrtc' mode and tries a direct peer-to-peer
  // connection. If that hasn't opened within `fallbackMs`, we assume
  // something is blocking it (VPN, firewall, restrictive network) and
  // switch to 'relay' mode: the same data, sent through the signaling
  // server instead of directly. This mirrors PairDrop's WS_FALLBACK for
  // exactly the same reason - see server.js for the tradeoff this implies.
  function createConnection(remoteId, isInitiator, label, fallbackMs, socketId) {
    const conn = {
      pc: null, channel: null, label, ready: false, mode: 'webrtc', fallbackTimer: null,
      socketId, isInitiator, usedSlots: new Set(), nextSlotHint: 0,
      reconnecting: false, reconnectTimer: null,
    };
    connections.set(remoteId, conn);

    const effectiveFallbackMs = fallbackMs ?? WEBRTC_FALLBACK_MS;
    if (effectiveFallbackMs <= 0) {
      // Relay forced from the start - skip WebRTC/offer-answer entirely
      // rather than racing an offer against an immediate close.
      switchToRelay(remoteId);
      return conn;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    conn.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && conn.socketId) socket.emit('signal', { to: conn.socketId, type: 'ice', candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (conn.mode !== 'webrtc') return;
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        conn.ready = false;
        refreshStatus();
        if (!intentionalDisconnect) scheduleReconnect(remoteId);
      }
    };

    const onOpen = () => {
      if (conn.mode === 'relay') return; // already fell back; ignore a late WebRTC connect
      clearTimeout(conn.fallbackTimer);
      conn.ready = true;
      retryCounts.delete(remoteId);
      refreshStatus();
      resumeStalledSends(remoteId);
    };
    const onMessage = (event) => {
      if (typeof event.data === 'string') onControlMessage(remoteId, event);
      else onFileChunk(remoteId, event);
    };

    if (isInitiator) {
      conn.channel = pc.createDataChannel('data', { ordered: true });
      wireChannel(conn.channel, onMessage, onOpen);
      makeOffer(pc, conn);
    } else {
      pc.ondatachannel = (e) => {
        conn.channel = e.channel;
        wireChannel(conn.channel, onMessage, onOpen);
      };
    }

    conn.fallbackTimer = setTimeout(() => switchToRelay(remoteId), effectiveFallbackMs);

    return conn;
  }

  function switchToRelay(remoteId) {
    const conn = connections.get(remoteId);
    if (!conn || conn.ready) return; // WebRTC already connected in time
    conn.mode = 'relay';
    conn.ready = true;
    retryCounts.delete(remoteId);
    try { conn.pc?.close(); } catch (e) {}
    refreshStatus();
    resumeStalledSends(remoteId);
  }

  // Ensures a usable connection to `clientId` exists, reusing one that's
  // already fine (a relay connection just gets marked ready again; a
  // healthy WebRTC one is left alone) and only recreating when the old one
  // is actually dead. Central entry point for "this device just joined /
  // rejoined / came back" from every code path that discovers that.
  function ensureConnection(clientId, socketId, isInitiator, label, fallbackMs) {
    const conn = connections.get(clientId);
    const pcHealthy = conn?.pc && !['closed', 'failed'].includes(conn.pc.connectionState);
    if (conn && (conn.mode === 'relay' || pcHealthy)) {
      conn.socketId = socketId;
      if (conn.mode === 'relay' && !conn.ready) {
        conn.ready = true;
        refreshStatus();
        resumeStalledSends(clientId);
      }
      return conn;
    }
    if (conn) closeConnection(clientId, { keepTransferState: true });
    return createConnection(clientId, isInitiator, label, fallbackMs, socketId);
  }

  // Only the initiator side actively redials (recreates the pc and sends a
  // fresh offer); the answerer just waits for that offer, which the
  // 'signal' handler above already knows how to adopt. Backoff is tracked
  // outside the (possibly-recreated) conn object so repeated failures
  // don't reset to hammering every second forever.
  function scheduleReconnect(clientId) {
    const conn = connections.get(clientId);
    if (!conn || conn.reconnecting || intentionalDisconnect) return;
    conn.reconnecting = true;
    const count = (retryCounts.get(clientId) || 0) + 1;
    retryCounts.set(clientId, count);
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** (count - 1));
    conn.reconnectTimer = setTimeout(() => {
      if (intentionalDisconnect || !connections.has(clientId)) return;
      const c = connections.get(clientId);
      c.reconnecting = false;
      if (c.isInitiator) ensureConnection(clientId, c.socketId, true, c.label, c.mode === 'relay' ? 0 : WEBRTC_FALLBACK_MS);
    }, delay);
  }

  // Sends either a JSON control string or a binary chunk to one connection,
  // over whichever transport that connection currently uses.
  function sendRaw(conn, data) {
    if (conn.mode === 'webrtc') {
      if (conn.channel?.readyState !== 'open') return false;
      conn.channel.send(data);
      return true;
    }
    if (conn.mode === 'relay') {
      if (!conn.ready || !conn.socketId || !socket.connected) return false;
      // Plain reliable emit, not volatile: volatile packets get silently
      // dropped whenever the transport is still flushing a previous write
      // (e.g. right after a burst of chunks), not just while disconnected -
      // that ate real file-end messages in testing. The `conn.ready` /
      // `socket.connected` guard above already keeps us from emitting into
      // a socket we know is down, so there's no double-delivery risk here
      // for socket.io's own reconnect-buffering to worry about.
      socket.emit('relay', { to: conn.socketId, payload: data });
      return true;
    }
    return false;
  }

  // Anything arriving via the relay fallback re-enters the exact same
  // handling as a WebRTC data channel message.
  socket.on('relay', ({ fromClientId, payload }) => {
    if (!fromClientId) return;
    if (typeof payload === 'string') onControlMessage(fromClientId, { data: payload });
    else onFileChunk(fromClientId, { data: payload });
  });

  function wireChannel(channel, onMessage, onOpen) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    channel.onmessage = onMessage;
    channel.onopen = onOpen;
  }

  async function makeOffer(pc, conn) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (conn.socketId) socket.emit('signal', { to: conn.socketId, type: 'offer', sdp: offer });
  }

  // `keepTransferState: true` means this is a "the old transport died, a
  // new one is coming" teardown (a reconnect), not a real goodbye - leave
  // outgoing/incoming state alone so a resume can pick it back up. Slot
  // bookkeeping for this specific connection is cleared either way; it's
  // meaningless without the connection it belonged to.
  function closeConnection(clientId, opts = {}) {
    const conn = connections.get(clientId);
    if (!conn) return;
    clearTimeout(conn.fallbackTimer);
    clearTimeout(conn.reconnectTimer);
    try { conn.pc?.close(); } catch (e) {}
    connections.delete(clientId);
    activeReceiveBySlot.delete(clientId);
    relayRoutes.delete(clientId);
    if (!opts.keepTransferState) {
      retryCounts.delete(clientId);
      for (const record of outgoing.values()) record.targets.delete(clientId);
    }
  }

  disconnectBtn.addEventListener('click', () => {
    intentionalDisconnect = true;
    for (const id of [...connections.keys()]) closeConnection(id);
    clearSession();
    socket.disconnect();
    window.location.reload();
  });

  // ---------- sending: targets & routing ----------
  // A message carries either `targets` (a list of recipient ids - used for
  // things everyone in scope should get: text, file offers) or `to` (a
  // single recipient - used for direct replies: accept/decline, resume
  // queries). Peers only ever talk to the host directly, so a peer always
  // hands the message to the host and lets it route from there; the host
  // either delivers directly (it already holds a connection to everyone)
  // or, when it's itself the intended recipient, handles it locally.

  // Host only: forward a `targets` message to everyone in scope except the
  // sender and the host itself.
  function deliverFromHost(msg, exceptId) {
    const targets = msg.targets && msg.targets.length ? msg.targets : [...connections.keys()];
    for (const id of targets) {
      if (id === exceptId || id === myId()) continue;
      const conn = connections.get(id);
      if (conn && conn.ready) sendRaw(conn, JSON.stringify(msg));
    }
  }

  // Host only: passthrough for a `to`-addressed message.
  function relayToOne(msg) {
    const conn = connections.get(msg.to);
    if (conn && conn.ready) sendRaw(conn, JSON.stringify(msg));
  }

  function amITarget(msg) {
    return !msg.targets || !msg.targets.length || msg.targets.includes(myId());
  }

  // Send a `targets`-addressed message that originates from this device.
  function sendOriginating(msg) {
    if (role === 'host') {
      deliverFromHost(msg, myId());
    } else {
      const conn = connections.get(hostClientId);
      if (conn) sendRaw(conn, JSON.stringify(msg));
    }
  }

  // Send a `to`-addressed reply that originates here.
  function sendToOne(msg) {
    if (role === 'host') {
      relayToOne(msg);
    } else {
      const conn = connections.get(hostClientId);
      if (conn) sendRaw(conn, JSON.stringify(msg));
    }
  }

  function waitForDrain(channel) {
    return new Promise((resolve) => {
      if (channel.bufferedAmount < BUFFERED_AMOUNT_HIGH_WATERMARK || channel.readyState !== 'open') return resolve();
      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onLow);
      };
      const onLow = () => { cleanup(); resolve(); };
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onLow);
    });
  }

  // ---------- binary chunk framing (1-byte slot prefix) ----------
  // Lets several files stream over the same connection's one ordered
  // channel at once: each active transfer claims a small slot number, and
  // every chunk it sends is tagged with that slot so the receiver (or a
  // relaying host) knows which file it belongs to.
  function packChunk(slot, buf) {
    const out = new Uint8Array(1 + buf.byteLength);
    out[0] = slot & 0xff;
    out.set(new Uint8Array(buf), 1);
    return out.buffer;
  }
  function unpackChunk(raw) {
    const view = new Uint8Array(raw);
    return { slot: view[0], payload: view.slice(1).buffer };
  }
  function allocSlot(conn) {
    for (let i = 0; i < 256; i++) {
      const slot = (conn.nextSlotHint + i) % 256;
      if (!conn.usedSlots.has(slot)) {
        conn.usedSlots.add(slot);
        conn.nextSlotHint = (slot + 1) % 256;
        return slot;
      }
    }
    return null; // 256 concurrent streams on one connection - not realistic
  }
  function freeSlot(conn, slot) {
    conn.usedSlots.delete(slot);
  }

  function setActiveSlot(connId, slot, fileId) {
    let m = activeReceiveBySlot.get(connId);
    if (!m) { m = new Map(); activeReceiveBySlot.set(connId, m); }
    m.set(slot, fileId);
  }
  function getActiveSlot(connId, slot) {
    return activeReceiveBySlot.get(connId)?.get(slot);
  }

  // ---------- sending: files & folders ----------
  // Every dropped/picked file starts its own send immediately - they run
  // concurrently (offers and accept/decline overlap freely; the actual
  // byte-streaming phase is capped at MAX_CONCURRENT_STREAMS so a pile of
  // files doesn't fight itself for bandwidth).
  function queueFiles(fileEntries) {
    for (const entry of fileEntries) {
      sendFile(entry.file, entry.relativePath).catch((e) => console.error('Send failed:', e));
    }
  }

  // Offers the file to every selected target, waits for each to accept or
  // decline, then streams it only to the ones who accepted. Each accepted
  // target gets its own resumable leg (see streamBytesFrom / markStalled /
  // resumeStalledSends) - a connection drop pauses that leg rather than
  // failing the whole transfer, and it picks back up once reconnected.
  async function sendFile(file, relativePath) {
    const targets = getSelectedTargets();
    if (!targets.length) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const path = relativePath || file.name;
    const row = addTransferRow(id, `${path} — waiting for accept...`, file.size, 'sending');

    const accepted = await new Promise((resolve) => {
      pendingOffers.set(id, { targets, responded: new Set(), accepted: new Set(), resolve });
      sendOriginating({ type: 'file-offer', id, name: file.name, path, size: file.size, from: myId(), targets });
    });

    const nameEl = row.querySelector('.name');
    if (!accepted.length) {
      nameEl.textContent = `↑ ${path} (declined)`;
      finishTransferRow(row);
      return;
    }
    nameEl.textContent = `↑ ${path}`;

    outgoing.set(id, {
      file, name: file.name, path, size: file.size, row,
      targets: new Map(accepted.map((t) => [t, { offset: 0, stalled: false, done: false }])),
    });

    await acquireStreamSlot();
    try {
      if (role === 'host') {
        // Host holds a direct connection to every target - each is its
        // own independently resumable leg.
        await Promise.all(accepted.map((tid) => streamBytesFrom(id, tid, 0, [tid])));
      } else {
        // Only one physical connection (to the host); it fans the same
        // bytes out to every other accepted target (see onControlMessage /
        // onFileChunk). Resuming this one leg resumes all of them at once.
        await streamBytesFrom(id, hostClientId, 0, accepted);
      }
    } finally {
      releaseStreamSlot();
    }
    // Don't finalize the row here - a leg may have stalled and still be
    // waiting to resume (outside this call, via resumeStalledSends).
    // checkTransferComplete (called from inside streamBytesFrom) owns that.
  }

  async function streamBytesFrom(fileId, wireClientId, startOffset, msgTargets) {
    const record = outgoing.get(fileId);
    if (!record) return;
    const conn = connections.get(wireClientId);
    if (!conn || !conn.ready) return markStalled(fileId, wireClientId, startOffset, msgTargets);

    const slot = allocSlot(conn);
    if (slot == null) return markStalled(fileId, wireClientId, startOffset, msgTargets);

    const startMsg = { type: 'file-start', id: fileId, name: record.name, path: record.path, size: record.size, from: myId(), targets: msgTargets, slot };
    if (startOffset > 0) { startMsg.resume = true; startMsg.offset = startOffset; }
    if (!sendRaw(conn, JSON.stringify(startMsg))) {
      freeSlot(conn, slot);
      return markStalled(fileId, wireClientId, startOffset, msgTargets);
    }

    let offset = startOffset;
    while (offset < record.size) {
      if (conn.mode === 'webrtc') {
        await waitForDrain(conn.channel);
        if (conn.channel.readyState !== 'open') break;
      }
      if (!conn.ready) break;
      const slice = record.file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      if (!sendRaw(conn, packChunk(slot, buf))) break;
      offset += buf.byteLength;
      for (const tid of msgTargets) {
        const t = record.targets.get(tid);
        if (t) t.offset = offset;
      }
      updateTransferRow(record.row, offset, record.size);
    }

    freeSlot(conn, slot);
    if (offset >= record.size) {
      sendRaw(conn, JSON.stringify({ type: 'file-end', id: fileId, slot }));
      for (const tid of msgTargets) {
        const t = record.targets.get(tid);
        if (t) t.done = true;
      }
    } else {
      markStalled(fileId, wireClientId, offset, msgTargets);
    }
    checkTransferComplete(fileId);
  }

  function markStalled(fileId, wireClientId, offset, msgTargets) {
    const record = outgoing.get(fileId);
    if (!record) return;
    for (const tid of msgTargets) {
      const t = record.targets.get(tid) || { offset };
      t.offset = offset;
      t.stalled = true;
      t.wireClientId = wireClientId;
      t.pendingTargets = msgTargets;
      record.targets.set(tid, t);
    }
    checkTransferComplete(fileId);
  }

  function checkTransferComplete(fileId) {
    const record = outgoing.get(fileId);
    if (!record) return;
    const allDone = [...record.targets.values()].every((t) => t.done);
    if (allDone) {
      outgoing.delete(fileId);
      finishTransferRow(record.row);
    }
  }

  // Called whenever a connection becomes ready again (WebRTC reopens, a
  // relay connection resumes, or a rejoin brings it back). Resumes exactly
  // once per stalled attempt on that wire - the entries are marked
  // not-stalled synchronously below, so a second concurrent call is a no-op.
  function resumeStalledSends(wireClientId) {
    for (const [fileId, record] of outgoing) {
      const stalledEntry = [...record.targets.values()].find((t) => t.stalled && t.wireClientId === wireClientId);
      if (!stalledEntry) continue;
      stalledEntry.stalled = false;
      queryResumeAndStream(fileId, wireClientId, stalledEntry.pendingTargets);
    }
  }

  // Asks each ultimate recipient how many bytes it actually has (the
  // receiver is the source of truth, not our own last-sent offset - it may
  // have missed some in-flight bytes when the connection dropped), then
  // resumes from the smallest of their answers. The receiver-side skip
  // logic (see onFileChunk) discards any overlap for anyone already ahead
  // of that point, so an imprecise or unanswered query just costs a little
  // redundant retransmission, never corruption.
  function queryOneResume(fileId, targetId) {
    return new Promise((resolve) => {
      const key = fileId + ':' + targetId;
      const timer = setTimeout(() => { resumeQueries.delete(key); resolve(null); }, RESUME_QUERY_TIMEOUT_MS);
      resumeQueries.set(key, (received) => { clearTimeout(timer); resolve(received); });
      sendToOne({ type: 'file-resume-query', id: fileId, to: targetId, from: myId() });
    });
  }

  async function queryResumeAndStream(fileId, wireClientId, targets) {
    const answers = await Promise.all(targets.map((tid) => queryOneResume(fileId, tid)));
    const known = answers.filter((a) => a != null && a >= 0);
    const startOffset = known.length ? Math.min(...known) : 0;
    await streamBytesFrom(fileId, wireClientId, startOffset, targets);
  }

  // Recursively read a dropped folder using the DataTransferItem API.
  function readEntryRecursively(entry, basePath) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file) => {
          resolve([{ file, relativePath: basePath + entry.name }]);
        }, () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const readBatch = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) {
              const results = await Promise.all(all);
              resolve(results.flat());
              return;
            }
            for (const child of entries) {
              all.push(readEntryRecursively(child, basePath + entry.name + '/'));
            }
            readBatch();
          }, () => resolve([]));
        };
        readBatch();
      } else {
        resolve([]);
      }
    });
  }

  // ---------- drop zone / file pickers ----------
  ['dragenter', 'dragover'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    })
  );

  dropZone.addEventListener('drop', async (e) => {
    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = Array.from(items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
      const groups = await Promise.all(entries.map((entry) => readEntryRecursively(entry, '')));
      queueFiles(groups.flat());
    } else {
      const files = Array.from(e.dataTransfer.files);
      queueFiles(files.map((file) => ({ file, relativePath: file.name })));
    }
  });

  pickFilesBtn.addEventListener('click', () => fileInput.click());
  pickFolderBtn.addEventListener('click', () => folderInput.click());

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    queueFiles(files.map((file) => ({ file, relativePath: file.name })));
    fileInput.value = '';
  });

  folderInput.addEventListener('change', () => {
    const files = Array.from(folderInput.files);
    queueFiles(files.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })));
    folderInput.value = '';
  });

  // ---------- text sharing ----------
  sendTextBtn.addEventListener('click', sendTextMessage);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendTextMessage();
  });

  function sendTextMessage() {
    const text = textInput.value.trim();
    if (!text) return;
    const targets = getSelectedTargets();
    sendOriginating({ type: 'text', text, from: myId(), targets });
    addTextLogEntry('You', text);
    textInput.value = '';
  }

  function addTextLogEntry(who, text) {
    const item = document.createElement('div');
    item.className = 'text-item';
    const pre = document.createElement('pre');
    pre.textContent = text;
    const wrap = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who;
    wrap.appendChild(label);
    wrap.appendChild(pre);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ghost small';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => navigator.clipboard.writeText(text).catch(() => {}));

    item.appendChild(wrap);
    item.appendChild(copyBtn);
    textLog.prepend(item);
  }

  // ---------- receiving (+ relay to other devices, host only) ----------
  async function onControlMessage(fromId, event) {
    if (typeof event.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    const originId = msg.from || fromId;

    if (msg.type === 'text') {
      if (role === 'host') deliverFromHost(msg, fromId);
      if (amITarget(msg)) addTextLogEntry(nameFor(originId), msg.text);
    } else if (msg.type === 'file-offer') {
      if (role === 'host') deliverFromHost(msg, fromId);
      if (amITarget(msg)) showOfferPrompt(msg, originId);
    } else if (msg.type === 'file-accept' || msg.type === 'file-decline' || msg.type === 'file-resume-query' || msg.type === 'file-resume-ack') {
      // All four are unicast (`to`-addressed) - the host passes through
      // anything not meant for itself, same as accept/decline always did.
      if (role === 'host' && msg.to !== myId()) { relayToOne(msg); return; }
      if (msg.type === 'file-accept' || msg.type === 'file-decline') {
        handleOfferResponse(msg);
      } else if (msg.type === 'file-resume-query') {
        const state = incoming.get(msg.id);
        sendToOne({ type: 'file-resume-ack', id: msg.id, to: msg.from, from: myId(), received: state ? state.received : -1 });
      } else {
        const key = msg.id + ':' + msg.from;
        const resolve = resumeQueries.get(key);
        if (resolve) { resumeQueries.delete(key); resolve(msg.received); }
      }
    } else if (msg.type === 'file-start') {
      if (role === 'host') {
        const fanoutIds = (msg.targets || []).filter((tid) => tid !== myId() && tid !== fromId);
        const fanoutTargets = [];
        for (const tid of fanoutIds) {
          const tConn = connections.get(tid);
          if (!tConn || !tConn.ready) continue;
          const destSlot = allocSlot(tConn);
          if (destSlot == null) continue;
          fanoutTargets.push({ clientId: tid, slot: destSlot });
          sendRaw(tConn, JSON.stringify({ ...msg, slot: destSlot }));
        }
        let routeMap = relayRoutes.get(fromId);
        if (!routeMap) { routeMap = new Map(); relayRoutes.set(fromId, routeMap); }
        routeMap.set(msg.slot, fanoutTargets);
      }
      if (amITarget(msg)) await beginReceive(msg, fromId, originId);
    } else if (msg.type === 'file-end') {
      if (role === 'host') {
        const routeMap = relayRoutes.get(fromId);
        const fanoutTargets = routeMap?.get(msg.slot);
        if (fanoutTargets) {
          for (const t of fanoutTargets) {
            const tConn = connections.get(t.clientId);
            if (tConn) {
              if (tConn.ready) sendRaw(tConn, JSON.stringify({ ...msg, slot: t.slot }));
              freeSlot(tConn, t.slot);
            }
          }
          routeMap.delete(msg.slot);
        }
      }
      if (incoming.has(msg.id)) await finishReceive(msg.id);
    }
  }

  // ---------- accept / decline ----------
  function showOfferPrompt(msg, originId) {
    const row = document.createElement('div');
    row.className = 'transfer-item offer';
    row.dataset.id = msg.id;
    row.innerHTML = `
      <div class="meta">
        <span class="name">↓ ${escapeHtml(msg.path || msg.name)} <span class="from">from ${escapeHtml(nameFor(originId))}</span></span>
        <span class="size">${formatBytes(msg.size)}</span>
      </div>
      <div class="offer-actions">
        <button class="secondary small accept-btn">Accept</button>
        <button class="ghost small decline-btn">Decline</button>
      </div>
    `;
    transferList.prepend(row);
    pendingIncoming.set(msg.id, { row });

    row.querySelector('.accept-btn').addEventListener('click', () => {
      sendToOne({ type: 'file-accept', id: msg.id, to: originId, from: myId() });
    }, { once: true });
    row.querySelector('.decline-btn').addEventListener('click', () => {
      sendToOne({ type: 'file-decline', id: msg.id, to: originId, from: myId() });
      row.remove();
      pendingIncoming.delete(msg.id);
    }, { once: true });
  }

  function handleOfferResponse(msg) {
    const pending = pendingOffers.get(msg.id);
    if (!pending) return;
    pending.responded.add(msg.from);
    if (msg.type === 'file-accept') pending.accepted.add(msg.from);
    if (pending.responded.size >= pending.targets.length) {
      pending.resolve([...pending.accepted]);
      pendingOffers.delete(msg.id);
    }
  }

  async function beginReceive(msg, fromId, originId) {
    let state = incoming.get(msg.id);
    if (state && msg.resume) {
      // Reconnected mid-transfer - keep everything we already have
      // (received bytes, the open file handle) and just point future
      // chunks at the new slot. skipRemaining absorbs any overlap if the
      // sender's resume point turns out to be earlier than what we've
      // actually got (see onFileChunk).
      state.skipRemaining = Math.max(0, state.received - (msg.offset || 0));
      setActiveSlot(fromId, msg.slot, state.id);
      return;
    }

    state = {
      id: msg.id,
      name: msg.name,
      path: msg.path || msg.name,
      size: msg.size,
      received: 0,
      chunks: [], // buffered until `writable` is ready, or the full set for a plain Blob download
      writable: null,
      streaming: false, // once true, chunks write straight to disk instead of buffering
      skipRemaining: 0,
    };

    // Register *before* any await below. A folder transfer may need to ask
    // the user to pick a save folder (a real permission prompt), and chunks
    // can keep arriving on the data channel while that's pending - buffering
    // them here means nothing is lost, and they get flushed to disk once
    // the folder is chosen.
    incoming.set(state.id, state);
    setActiveSlot(fromId, msg.slot, state.id);

    const pending = pendingIncoming.get(msg.id);
    if (pending) {
      state.row = pending.row;
      pending.row.classList.remove('offer');
      const actions = pending.row.querySelector('.offer-actions');
      if (actions) actions.outerHTML = '<div class="progress-track"><div class="progress-fill"></div></div>';
      pendingIncoming.delete(msg.id);
    } else {
      state.row = addTransferRow(state.id, `${state.path} (from ${nameFor(originId)})`, state.size, 'receiving');
    }

    if (window.showDirectoryPicker && state.path.includes('/')) {
      try {
        if (!saveDirHandle) {
          saveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        }
        const parts = state.path.split('/');
        const fileName = parts.pop();
        let dir = saveDirHandle;
        for (const part of parts) {
          dir = await dir.getDirectoryHandle(part, { create: true });
        }
        const fileHandle = await dir.getFileHandle(fileName, { create: true });
        state.writable = await fileHandle.createWritable();

        // Flush anything that arrived while we were waiting for permission.
        for (const buf of state.chunks) await state.writable.write(buf);
        state.chunks = [];
        state.streaming = true;
      } catch (e) {
        console.warn('Falling back to per-file download (no folder access):', e);
        state.writable = null;
      }
    }
  }

  async function onFileChunk(fromId, event) {
    if (typeof event.data === 'string') return;
    const { slot, payload } = unpackChunk(event.data);

    if (role === 'host') {
      const fanoutTargets = relayRoutes.get(fromId)?.get(slot);
      if (fanoutTargets) {
        for (const t of fanoutTargets) {
          const tConn = connections.get(t.clientId);
          if (tConn && tConn.ready) sendRaw(tConn, packChunk(t.slot, payload));
        }
      }
    }

    const fid = getActiveSlot(fromId, slot);
    const active = fid ? incoming.get(fid) : null;
    if (!active) return; // host is only relaying this one, not itself a recipient

    let data = payload;
    if (active.skipRemaining > 0) {
      // Overlap from a resume that started earlier than what we already
      // have - drop the part we've already got, keep only what's new.
      if (active.skipRemaining >= data.byteLength) {
        active.skipRemaining -= data.byteLength;
        return;
      }
      data = data.slice(active.skipRemaining);
      active.skipRemaining = 0;
    }

    active.received += data.byteLength;

    if (active.streaming) {
      await active.writable.write(data);
    } else {
      active.chunks.push(data);
    }

    updateTransferRow(active.row, active.received, active.size);
  }

  async function finishReceive(id) {
    const state = incoming.get(id);
    if (!state) return;

    if (state.writable) {
      await state.writable.close();
    } else {
      const blob = new Blob(state.chunks, { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = state.path.includes('/') ? state.path.replace(/\//g, '__') : state.path;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    finishTransferRow(state.row);
    incoming.delete(id);
  }

  // ---------- transfer list UI ----------
  function addTransferRow(id, name, size, direction) {
    const row = document.createElement('div');
    row.className = 'transfer-item';
    row.dataset.id = id;
    row.innerHTML = `
      <div class="meta">
        <span class="name">${direction === 'sending' ? '↑' : '↓'} ${escapeHtml(name)}</span>
        <span class="size">${formatBytes(size)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill"></div></div>
    `;
    transferList.prepend(row);
    return row;
  }

  function updateTransferRow(row, received, size) {
    if (!row) return;
    const pct = size ? Math.min(100, (received / size) * 100) : 100;
    const fill = row.querySelector('.progress-fill');
    if (fill) fill.style.width = `${pct}%`;
  }

  function finishTransferRow(row) {
    if (!row) return;
    row.classList.add('done');
    const fill = row.querySelector('.progress-fill');
    if (fill) fill.style.width = '100%';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
