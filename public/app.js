(() => {
  'use strict';

  // ---------- transfer tuning ----------
  // Same shape as PairDrop's protocol: 64KB frames, and the receiver reports
  // progress so the sender never has more than SEND_WINDOW bytes in flight.
  // Unlike PairDrop that applies on BOTH paths (direct and via the server),
  // so a relayed multi-GB file can't pile up in memory on either end.
  const CHUNK_SIZE = 64 * 1024;
  const READ_BLOCK = 1024 * 1024; // file.slice() granularity - read big, send as CHUNK_SIZE frames
  const SEND_WINDOW = 4 * 1024 * 1024; // max un-acked bytes in flight per recipient
  const ACK_EVERY = 512 * 1024; // receiver acks after this many more bytes are safely written
  const ACK_STALL_MS = 20000; // no ack progress for this long -> free the stream slot, wait for a pull
  const BUFFERED_AMOUNT_LOW_THRESHOLD = 1 * 1024 * 1024;
  const BUFFERED_AMOUNT_HIGH_WATERMARK = 8 * 1024 * 1024;
  const STREAM_TO_DISK_MIN = 64 * 1024 * 1024; // single files this big get a Save As + streaming (when the browser can)
  const BLOB_PART_SIZE = 32 * 1024 * 1024; // buffered receives are folded into Blobs this big so the browser can page them to disk

  // How many files stream their bytes at once. Offers still happen
  // immediately and concurrently - this only caps simultaneous streaming.
  const MAX_CONCURRENT_STREAMS = window.__DROPCODE_MAX_STREAMS ?? 3;

  // A new connection tries a direct WebRTC link first. If that hasn't opened
  // within this long (or fails outright - VPNs and firewalls commonly block
  // it), the connection carries on through the server relay so it's usable
  // immediately; a direct link that opens later still takes over for new
  // traffic. Open the page with ?direct=0 to skip the direct attempt
  // entirely - handy for reproducing a network that blocks WebRTC.
  const RELAY_GRACE_MS = window.__DROPCODE_GRACE_MS ?? 2500;
  const NO_DIRECT = new URLSearchParams(window.location.search).get('direct') === '0';
  const DIRECT_RETRY_MAX = 6; // background attempts to get a direct link after it drops (initiator only)

  // The receiver drives recovery: it knows exactly how many bytes it has, so
  // when nothing has arrived for PULL_AFTER_MS (or a connection just came
  // back) it asks the sender to resume from that byte. The sender keeps no
  // resume bookkeeping beyond holding the File.
  const TICK_MS = 2000;
  const PULL_AFTER_MS = 8000;
  const CHECK_EVERY_MS = 8000; // sender re-asks "did you get it all?" until the receiver confirms
  const OFFER_RETRY_MS = 10000; // re-send an offer nobody has answered (it may have been lost mid-reconnect)
  const OFFER_GONE_MS = 20000; // an unanswered offer to a device that left the room is dropped after this

  // Default until /api/network-info answers; replaced with the server's
  // configured list (which includes a TURN server if the deploy set
  // TURN_URLS) as soon as that fetch resolves - see networkInfoPromise.
  let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

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
  // stranger after a brief network blip.
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
  const offerBar = $('offerBar');
  const offerBarText = $('offerBarText');
  const acceptAllBtn = $('acceptAllBtn');
  const declineAllBtn = $('declineAllBtn');
  const selectAllBtn = $('selectAllBtn');
  const sendSummary = $('sendSummary');
  const clearDoneBtn = $('clearDoneBtn');
  const offerDialog = $('offerDialog');
  const offerTitle = $('offerTitle');
  const offerSub = $('offerSub');
  const offerFiles = $('offerFiles');
  const offerNote = $('offerNote');
  const offerAcceptBtn = $('offerAcceptBtn');
  const offerDeclineBtn = $('offerDeclineBtn');

  myNameInput.value = loadName();

  function currentName() {
    return (myNameInput.value || myNameInputSession.value || '').trim().slice(0, 40);
  }

  // ---------- state ----------
  // websocket first: socket.io's default (long-polling, then upgrade) would
  // push the first chunks of a relayed transfer through base64'd HTTP polling.
  const socket = io({ transports: ['websocket', 'polling'] });
  let role = null; // 'host' | 'peer'
  let hostClientId = null; // for a peer: the host's stable id (its one connection)
  let currentCode = null; // the room code we're currently in, if any
  let intentionalDisconnect = false;
  let hasEverConnected = false;
  let saveDirHandle = null; // File System Access API directory handle, if chosen

  // clientId -> connection state, keyed by the STABLE id so a device that
  // blips and reconnects is recognized as the same connection.
  //   mode  'pending' (waiting on the direct link, up to RELAY_GRACE_MS) |
  //         'webrtc' (data channel open) | 'relay' (through the server)
  //   ready "can send in the current mode right now"
  //   direct whether a data channel is open - tracked separately so a
  //         relay connection notices when the direct link comes up
  // Control JSON and binary frames share one ordered path per stream, and
  // each stream pins its path when it starts (see serve) - two paths have
  // no ordering guarantee between them.
  const connections = new Map();
  const retryCounts = new Map(); // clientId -> consecutive failed direct-link attempts

  // fileId -> receive state (see createIncoming); connId -> Map(slot -> fileId)
  // for whatever's actively streaming in on that connection right now.
  const incoming = new Map();
  const activeReceiveBySlot = new Map();
  // fileId -> { msg, originId, row } for an offer this device hasn't answered yet.
  const pendingIncoming = new Map();
  // Host only: connId -> Map(sourceSlot -> [{clientId, slot, via}]) - which of
  // this connection's active incoming streams get mirrored onward to which
  // other connections (each with its OWN slot, since a slot is only
  // meaningful within one connection's namespace).
  const relayRoutes = new Map();
  // fileId -> { id, file, name, path, size, row, ackWaiters, targets: Map(clientId ->
  //   { accepted, declined, done, gen, acked, lastOffer, endSentAt, missingSince }) }
  // Sender side. A target is "done" only when the receiver confirmed it wrote every byte.
  const outgoing = new Map();
  // Ids of files this device fully received - lets a late "did you get it?"
  // be answered even though the receive state is long gone.
  const completedReceives = new Set();
  const declinedIds = new Set(); // offers we declined - a re-sent offer gets the same answer, not a second prompt

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
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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

  // ---------- choosing who to send to ----------
  // Every other device in the room is a card you tick or untick. New devices
  // start ticked (so by default a send goes to everyone); what you untick is
  // remembered here, not read back out of the DOM, so re-rendering as
  // connections change never loses your choice. Nothing ticked means nothing
  // is sent - the Send controls lock and say why, rather than quietly
  // falling back to "everyone".
  const deselected = new Set();
  let lastDeviceHtml = '';
  let sendEnabled = false;

  const othersInRoom = () => roster.filter((d) => d.id !== myId());

  function getSelectedTargets() {
    return othersInRoom().filter((d) => !deselected.has(d.id)).map((d) => d.id);
  }

  // "Direct" / "Relayed" describe our own link to that device; a peer only
  // has a link to the host, so everyone else is reached through it.
  function deviceMeta(d) {
    const viaHost = role === 'peer' && !d.isHost;
    const conn = connections.get(viaHost ? hostClientId : d.id);
    const state = !conn ? 'Joining…' : !conn.ready ? 'Reconnecting…' : conn.mode === 'relay' ? 'Relayed' : 'Direct';
    return `${d.isHost ? 'Host · ' : ''}${viaHost ? 'via host · ' : ''}${state}`;
  }

  function renderDeviceList() {
    const others = othersInRoom();
    for (const id of [...deselected]) if (!others.some((d) => d.id === id)) deselected.delete(id);

    const html = others.length
      ? others.map((d) => {
          const name = d.name || 'Device';
          const hue = [...d.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
          return `<label class="device-chip">
            <input type="checkbox" class="target-check" data-id="${escapeHtml(d.id)}" ${deselected.has(d.id) ? '' : 'checked'} />
            <span class="avatar" style="--h:${hue}">${escapeHtml(Array.from(name)[0].toUpperCase())}</span>
            <span class="chip-text"><span class="chip-name">${escapeHtml(name)}</span><span class="chip-meta">${escapeHtml(deviceMeta(d))}</span></span>
            <span class="tick"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg></span>
          </label>`;
        }).join('')
      : '<p class="hint">No other devices yet — share the code or link and they\'ll appear here.</p>';
    if (html !== lastDeviceHtml) { // skip the rebuild (and its flicker) when nothing changed
      deviceList.innerHTML = html;
      lastDeviceHtml = html;
    }
    updateSendState();
  }

  function updateSendState() {
    const others = othersInRoom();
    const n = getSelectedTargets().length;
    sendEnabled = n > 0;
    selectAllBtn.classList.toggle('hidden', others.length < 2);
    selectAllBtn.textContent = n === others.length ? 'Select none' : 'Select all';
    if (!others.length) sendSummary.textContent = 'Waiting for another device to join.';
    else if (!n) sendSummary.textContent = 'Select at least one device to send to.';
    else if (n === others.length) sendSummary.textContent = others.length === 1 ? `Sending to ${others[0].name || 'Device'}.` : `Sending to everyone (${n} devices).`;
    else sendSummary.textContent = `Sending to ${n} of ${others.length} devices.`;
    dropZone.classList.toggle('is-disabled', !sendEnabled);
    for (const b of [pickFilesBtn, pickFolderBtn, sendTextBtn, textInput]) b.disabled = !sendEnabled;
  }

  deviceList.addEventListener('change', (e) => {
    const box = e.target.closest('.target-check');
    if (!box) return;
    if (box.checked) deselected.delete(box.dataset.id);
    else deselected.add(box.dataset.id);
    renderDeviceList();
  });

  selectAllBtn.addEventListener('click', () => {
    const others = othersInRoom();
    if (getSelectedTargets().length === others.length) others.forEach((d) => deselected.add(d.id));
    else deselected.clear();
    renderDeviceList();
  });

  function setStatus(connected, text) {
    statusDot.classList.toggle('connected', connected);
    statusText.textContent = text;
  }

  function enterSession() {
    setupPanel.classList.add('hidden');
    sessionPanel.classList.remove('hidden');
    myNameInputSession.value = currentName();
  }

  // ---------- shareable link + ICE server config ----------
  // Fetched once at startup (not lazily on first host) so a peer's very
  // first RTCPeerConnection also gets any TURN server the deploy configured,
  // not just the host's. NOT window.location.href for the link: if the host
  // happened to open the page via "localhost" (or any address other than
  // the one on the LAN), that would be meaningless to share - a friend's
  // "localhost" means their own machine, not the host's.
  let networkInfo = null;
  const networkInfoPromise = fetch('/api/network-info')
    .then((r) => r.json())
    .then((info) => {
      networkInfo = info;
      if (Array.isArray(info.iceServers) && info.iceServers.length) ICE_SERVERS = info.iceServers;
      return info;
    })
    .catch(() => (networkInfo = {}));

  async function getShareableLink() {
    if (!networkInfo) await networkInfoPromise;
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

  // navigator.clipboard only exists in secure contexts - i.e. not on the
  // plain-http LAN address this app is normally shared over - so fall back
  // to a hidden textarea + execCommand. Briefly relabels the button so the
  // user can see it worked.
  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) {}
      ta.remove();
      btn.focus();
    }
    const label = btn.lastChild; // the text node, after any icon
    const orig = (btn.dataset.label ||= label.textContent);
    label.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { label.textContent = orig; }, 1500);
  }

  copyCodeBtn.addEventListener('click', () => copyText(codeDisplay.textContent, copyCodeBtn));
  copyLinkBtn.addEventListener('click', () => copyText(linkDisplay.textContent, copyLinkBtn));

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
        ensureConnection(hostClientId, res.hostSocketId, false, 'Host');
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
      ensureConnection(p.clientId, p.socketId, true, nameFor(p.clientId));
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
        if (res.hostSocketId) ensureConnection(hostClientId, res.hostSocketId, false, 'Host');
        refreshStatus();
      });
    }
  });

  // The signaling socket itself dropped. A relay-mode connection tunnels
  // through it directly, so pause (not abandon) those - the reconnect
  // handler above marks them ready again once we're back. A direct
  // connection that's already established doesn't depend on this socket.
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
  // blip/reload under a fresh socket id. Either way our side of the old
  // direct link may be dead without knowing it yet, so `fresh` starts a new
  // attempt (the relay covers the gap).
  socket.on('peer-joined', ({ peerClientId, peerSocketId }) => {
    if (role !== 'host') return;
    deviceCounter += 1;
    ensureConnection(peerClientId, peerSocketId, true, `Device ${deviceCounter}`, true);
    refreshStatus();
  });

  // A peer's socket disconnected (host only). A brief blip looks identical
  // to leaving for good here, so only the transport is torn down - nothing
  // transfer-related. If the peer comes back, its receiver pulls and the
  // transfer carries on.
  socket.on('peer-left', ({ peerClientId }) => {
    closeConnection(peerClientId);
    refreshStatus();
  });

  // The host dropped (reload, blip, or real disconnect) - not necessarily
  // final. It has a window to come back before the session actually ends
  // (see 'host-left' below). Pause our connection to it rather than
  // abandoning it, so in-flight transfers can resume once it's back.
  socket.on('host-disconnected', () => {
    const conn = hostClientId && connections.get(hostClientId);
    if (conn && conn.mode === 'relay') conn.ready = false;
    setStatus(false, 'Host disconnected — waiting for it to reconnect...');
  });

  // The host came back within its reconnect window (peer only).
  socket.on('host-reconnected', ({ hostClientId: hcid, hostSocketId }) => {
    if (role !== 'peer') return;
    hostClientId = hcid;
    ensureConnection(hostClientId, hostSocketId, false, 'Host');
    refreshStatus();
  });

  // The host's reconnect window ran out (or it disconnected for good).
  socket.on('host-left', () => {
    setStatus(false, 'The host ended the session.');
    for (const id of [...connections.keys()]) closeConnection(id);
    outgoing.clear();
    incoming.clear();
    pendingIncoming.clear();
    updateOfferBar();
    currentCode = null;
    clearSession();
  });

  socket.on('signal', async (data) => {
    const fromClientId = data.fromClientId;
    if (!fromClientId) return;

    let conn = connections.get(fromClientId);
    if (conn) conn.socketId = data.from; // keep "where to reach them" current

    try {
      if (data.type === 'offer') {
        if (!conn) {
          conn = createConnection(fromClientId, false, role === 'peer' ? 'Host' : nameFor(fromClientId), data.from);
        } else if (!conn.pc || conn.pc.remoteDescription) {
          // A fresh offer on a connection that already negotiated means the
          // other side restarted its end - drop ours and answer anew.
          closeDirect(conn);
          setDirect(conn, false);
          startDirect(conn);
        }
        const pc = conn.pc;
        if (!pc) return; // no WebRTC here - the relay is all we have
        await pc.setRemoteDescription(data.sdp);
        await flushIce(conn);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: conn.socketId, type: 'answer', sdp: answer });
      } else if (!conn || !conn.pc) {
        return; // an answer/ice for a connection we don't recognize
      } else if (data.type === 'answer') {
        await conn.pc.setRemoteDescription(data.sdp);
        await flushIce(conn);
      } else if (data.type === 'ice' && data.candidate) {
        // Candidates can outrun the description they belong to (trickle ICE
        // over a socket is not ordered against async setRemoteDescription);
        // adding one early throws and the candidate is lost for good - the
        // classic cause of a link that "sometimes just doesn't connect".
        if (conn.pc.remoteDescription) await conn.pc.addIceCandidate(data.candidate).catch(() => {});
        else conn.pendingIce.push(data.candidate);
      }
    } catch (e) {
      console.error('Signaling error', e);
    }
  });

  async function flushIce(conn) {
    const queued = conn.pendingIce.splice(0);
    for (const c of queued) await conn.pc.addIceCandidate(c).catch(() => {});
  }

  // ---------- connections: direct WebRTC, with the server relay underneath ----------
  // Every connection is usable through the relay no later than RELAY_GRACE_MS
  // after it's created (immediately if the direct attempt fails outright), and
  // switches to the direct link whenever one is open. This is the mirror
  // image of PairDrop's WS fallback - same protocol both ways - with the
  // difference that falling back doesn't strand a transfer: a stream that
  // loses its path just ends and the receiver pulls the rest on the new one.
  function createConnection(remoteId, isInitiator, label, socketId) {
    const conn = {
      id: remoteId, pc: null, channel: null, label, socketId, isInitiator,
      mode: 'pending', ready: false, direct: false,
      graceTimer: null, retryTimer: null, pendingIce: [],
      usedSlots: new Set(), nextSlotHint: 0,
    };
    connections.set(remoteId, conn);
    if (NO_DIRECT || typeof RTCPeerConnection === 'undefined') {
      conn.graceTimer = setTimeout(() => useRelay(conn), 0);
    } else {
      startDirect(conn);
      conn.graceTimer = setTimeout(() => useRelay(conn), RELAY_GRACE_MS);
    }
    return conn;
  }

  function startDirect(conn) {
    if (NO_DIRECT || typeof RTCPeerConnection === 'undefined') return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    conn.pc = pc;
    conn.pendingIce = [];

    pc.onicecandidate = (e) => {
      if (e.candidate && conn.socketId) socket.emit('signal', { to: conn.socketId, type: 'ice', candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (conn.pc !== pc) return; // an old pc's late event
      const s = pc.connectionState;
      if (s === 'connected') {
        if (conn.channel?.readyState === 'open') setDirect(conn, true);
      } else if (s === 'disconnected') {
        setDirect(conn, false); // may heal by itself - then 'connected' fires again
      } else if (s === 'failed' || s === 'closed') {
        setDirect(conn, false);
        scheduleDirectRetry(conn);
      }
    };

    const wire = (channel) => {
      conn.channel = channel;
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
      channel.onopen = () => { if (conn.pc === pc) setDirect(conn, true); };
      channel.onclose = () => {
        if (conn.pc !== pc) return;
        setDirect(conn, false);
        scheduleDirectRetry(conn);
      };
      channel.onmessage = (event) => {
        if (typeof event.data === 'string') onControlMessage(conn.id, event);
        else onFileChunk(conn.id, event);
      };
      if (channel.readyState === 'open') setDirect(conn, true); // open before we got to listen
    };

    if (conn.isInitiator) {
      wire(pc.createDataChannel('data', { ordered: true }));
      makeOffer(pc, conn);
    } else {
      pc.ondatachannel = (e) => wire(e.channel);
    }
  }

  async function makeOffer(pc, conn) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (conn.socketId && conn.pc === pc) socket.emit('signal', { to: conn.socketId, type: 'offer', sdp: offer });
    } catch (e) {
      console.error('Offer failed', e);
    }
  }

  function closeDirect(conn) {
    const pc = conn.pc;
    conn.pc = null;
    conn.channel = null;
    conn.pendingIce = [];
    try { pc?.close(); } catch (e) {}
  }

  // Only the initiator redials; the answerer just adopts the next offer (see
  // the 'signal' handler). Backoff is tracked outside the connection object
  // so repeated failures don't reset to hammering every second forever -
  // and after DIRECT_RETRY_MAX the connection simply stays on the relay.
  function scheduleDirectRetry(conn) {
    if (!conn.isInitiator || conn.retryTimer || intentionalDisconnect) return;
    const n = (retryCounts.get(conn.id) || 0) + 1;
    if (n > DIRECT_RETRY_MAX) return;
    retryCounts.set(conn.id, n);
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = null;
      if (connections.get(conn.id) === conn && !conn.direct) restartDirect(conn);
    }, Math.min(30000, 2000 * 2 ** (n - 1)));
  }

  function restartDirect(conn) {
    closeDirect(conn);
    setDirect(conn, false);
    startDirect(conn);
  }

  // The direct link came up or went down. Coming up switches the connection
  // over (new traffic only - running streams keep the path they started on);
  // going down drops back to the relay at once and asks the receivers to
  // re-pull whatever was in flight on the dead channel.
  function setDirect(conn, up) {
    conn.direct = up;
    if (up) {
      clearTimeout(conn.graceTimer);
      retryCounts.delete(conn.id);
      if (conn.mode !== 'webrtc') applyMode(conn, 'webrtc');
    } else if (conn.mode !== 'relay') {
      applyMode(conn, 'relay', true);
    }
  }

  function useRelay(conn) {
    if (connections.get(conn.id) !== conn || conn.mode !== 'pending') return;
    applyMode(conn, 'relay');
  }

  function applyMode(conn, mode, repull) {
    const wasReady = conn.ready;
    conn.mode = mode;
    conn.ready = mode === 'webrtc' || (mode === 'relay' && socket.connected && !!conn.socketId);
    refreshStatus();
    if ((conn.ready && !wasReady) || (repull && conn.ready)) onConnectionReady(conn.id);
  }

  // Ensures a usable connection to `clientId` exists, reusing one that's
  // already fine. Central entry point for "this device just joined /
  // rejoined / came back" from every code path that discovers that.
  // `fresh`: the remote side rejoined, so restart our end of the direct link.
  function ensureConnection(clientId, socketId, isInitiator, label, fresh) {
    const conn = connections.get(clientId);
    if (!conn) return createConnection(clientId, isInitiator, label, socketId);
    conn.socketId = socketId;
    if (conn.mode === 'relay' && !conn.ready && socket.connected) {
      conn.ready = true;
      refreshStatus();
      onConnectionReady(clientId);
    }
    const dead = !conn.pc || ['failed', 'closed'].includes(conn.pc.connectionState);
    if (conn.isInitiator && (fresh || dead)) restartDirect(conn);
    return conn;
  }

  // `keep`: nothing transfer-related is touched here. Receivers hold their own
  // progress and pull again once there's a connection to pull over.
  function closeConnection(clientId) {
    const conn = connections.get(clientId);
    if (!conn) return;
    // Set *before* deleting from the map: a send loop elsewhere holds this
    // same object by reference and only checks `conn.ready`.
    conn.ready = false;
    clearTimeout(conn.graceTimer);
    clearTimeout(conn.retryTimer);
    closeDirect(conn);
    connections.delete(clientId);
    activeReceiveBySlot.delete(clientId);
    const routes = relayRoutes.get(clientId);
    if (routes) {
      for (const targets of routes.values()) for (const t of targets) { const c = connections.get(t.clientId); if (c) freeSlot(c, t.slot); }
      relayRoutes.delete(clientId);
    }
    retryCounts.delete(clientId);
  }

  disconnectBtn.addEventListener('click', () => {
    intentionalDisconnect = true;
    for (const id of [...connections.keys()]) closeConnection(id);
    clearSession();
    socket.disconnect();
    window.location.reload();
  });

  // Can `conn` carry traffic on `via` right now? A stream pins `via` when it
  // starts, so a connection switching modes mid-stream doesn't reorder it.
  function canSend(conn, via) {
    if (via === 'webrtc') return conn.channel?.readyState === 'open';
    if (via === 'relay') return socket.connected && !!conn.socketId;
    return false;
  }

  // Sends either a JSON control string or a binary frame to one connection.
  function sendRaw(conn, data, via = conn.mode) {
    if (!canSend(conn, via) || (via === conn.mode && !conn.ready)) return false;
    try {
      if (via === 'webrtc') conn.channel.send(data);
      // Plain reliable emit, not volatile: volatile packets get silently
      // dropped while the transport is still flushing a previous write.
      else socket.emit('relay', { to: conn.socketId, payload: data });
      return true;
    } catch (e) {
      return false; // send() throws on a closing channel or an overflowed buffer
    }
  }

  // Anything arriving via the relay re-enters the exact same handling as a
  // data channel message.
  socket.on('relay', ({ fromClientId, payload }) => {
    if (!fromClientId) return;
    if (typeof payload === 'string') onControlMessage(fromClientId, { data: payload });
    else onFileChunk(fromClientId, { data: payload });
  });

  // ---------- sending: targets & routing ----------
  // A message carries either `targets` (a list of recipient ids - used for
  // things everyone in scope should get: text, file offers) or `to` (a
  // single recipient - used for direct replies: accept/decline, acks,
  // pulls). Peers only ever talk to the host directly, so a peer always
  // hands the message to the host and lets it route from there; the host
  // either delivers directly (it already holds a connection to everyone)
  // or, when it's itself the intended recipient, handles it locally.

  // Host only: forward a `targets` message to everyone in scope except the
  // sender and the host itself. Returns how many connections it went out on.
  function deliverFromHost(msg, exceptId) {
    const targets = msg.targets && msg.targets.length ? msg.targets : [...connections.keys()];
    let sent = 0;
    for (const id of targets) {
      if (id === exceptId || id === myId()) continue;
      const conn = connections.get(id);
      if (conn && conn.ready && sendRaw(conn, JSON.stringify(msg))) sent++;
    }
    return sent;
  }

  // Host only: passthrough for a `to`-addressed message.
  function relayToOne(msg) {
    const conn = connections.get(msg.to);
    return !!(conn && conn.ready && sendRaw(conn, JSON.stringify(msg)));
  }

  function amITarget(msg) {
    return !msg.targets || !msg.targets.length || msg.targets.includes(myId());
  }

  // Send a `targets`-addressed message that originates from this device.
  function sendOriginating(msg) {
    if (role === 'host') return deliverFromHost(msg, myId()) > 0;
    const conn = connections.get(hostClientId);
    return !!(conn && sendRaw(conn, JSON.stringify(msg)));
  }

  // Send a `to`-addressed message that originates here.
  function sendToOne(msg) {
    if (role === 'host') return relayToOne(msg);
    const conn = connections.get(hostClientId);
    return !!(conn && sendRaw(conn, JSON.stringify(msg)));
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

  // ---------- binary frame: [slot u8][offset f64][payload] ----------
  // The slot lets several files stream over one connection at once; the
  // offset makes every frame self-describing, so the receiver can drop a
  // duplicate or a frame after a gap instead of silently writing bytes in
  // the wrong place - resuming never relies on counting what was skipped.
  const HEADER = 9;
  function packChunk(slot, offset, bytes) {
    const out = new Uint8Array(HEADER + bytes.length);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, slot);
    dv.setFloat64(1, offset);
    out.set(bytes, HEADER);
    return out.buffer;
  }
  function unpackChunk(raw) {
    const dv = new DataView(raw);
    return { slot: dv.getUint8(0), offset: dv.getFloat64(1), payload: new Uint8Array(raw, HEADER) };
  }
  // Copy of a frame addressed to a different slot (host fan-out).
  function reslot(raw, slot) {
    const copy = raw.slice(0);
    new Uint8Array(copy)[0] = slot;
    return copy;
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
  // Every dropped/picked file is offered immediately and independently.
  // Each recipient who accepts gets their own stream (`serve`); the sender
  // keeps the File until that recipient confirms it has every byte.
  function queueFiles(fileEntries) {
    if (!sendEnabled) return; // nobody selected - the Send card says so
    for (const entry of fileEntries) sendFile(entry.file, entry.relativePath);
  }

  const offerMsg = (r, targets) => ({ type: 'file-offer', id: r.id, name: r.name, path: r.path, size: r.size, from: myId(), targets });

  function sendFile(file, relativePath) {
    const targets = getSelectedTargets();
    if (!targets.length) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const path = relativePath || file.name;
    const row = addTransferRow(id, path, file.size, 'sending');
    const now = Date.now();
    const record = {
      id, file, name: file.name, path, size: file.size, row, ackWaiters: [], meter: {},
      targets: new Map(targets.map((t) => [t, { accepted: false, declined: false, done: false, gen: 0, acked: 0, lastOffer: now, endSentAt: 0, missingSince: 0 }])),
    };
    outgoing.set(id, record);
    refreshSendRow(record);
    sendOriginating(offerMsg(record, targets));
  }

  // Streams the file to one recipient from `startOffset`. Calling it again
  // for the same recipient (a pull) supersedes the running stream. It never
  // reports failure upward: if the path dies the loop just ends, and the
  // receiver - which knows what it has - pulls again.
  async function serve(record, tid, startOffset) {
    const t = record.targets.get(tid);
    if (!t || t.done || t.declined) return;
    const gen = ++t.gen;
    t.endSentAt = 0;
    t.queued = true;
    await acquireStreamSlot();
    t.queued = false;
    try {
      const wireId = role === 'host' ? tid : hostClientId;
      const conn = connections.get(wireId);
      const alive = () => t.gen === gen && !t.done && !t.declined && connections.get(wireId) === conn;
      if (!conn || !alive() || !conn.ready) return; // no path right now - the receiver will pull again
      const slot = allocSlot(conn);
      if (slot == null) return;
      // A pull can beat our own "channel closed" event; don't pin a new stream to a dead channel.
      const via = conn.mode === 'webrtc' && conn.channel?.readyState !== 'open' ? 'relay' : conn.mode;
      try {
        t.acked = startOffset;
        const start = { type: 'file-start', id: record.id, name: record.name, path: record.path, size: record.size, from: myId(), targets: [tid], slot, offset: startOffset };
        if (!sendRaw(conn, JSON.stringify(start), via)) return;

        let offset = startOffset;
        let block = null;
        let blockAt = 0;
        let ackedSeen = t.acked;
        let ackedAt = Date.now();
        while (offset < record.size) {
          // Flow control: wait for the receiver to confirm bytes, don't just
          // keep queueing into the transport.
          while (offset - t.acked >= SEND_WINDOW) {
            await waitForAck(record, 1000);
            if (!alive() || !canSend(conn, via)) return;
            if (t.acked > ackedSeen) { ackedSeen = t.acked; ackedAt = Date.now(); }
            else if (Date.now() - ackedAt > ACK_STALL_MS) return;
          }
          if (!alive() || !canSend(conn, via)) return;
          if (via === 'webrtc') {
            await waitForDrain(conn.channel);
            if (!alive() || conn.channel?.readyState !== 'open') return;
          }
          if (!block || offset < blockAt || offset >= blockAt + block.length) {
            blockAt = offset;
            try {
              block = new Uint8Array(await record.file.slice(offset, offset + READ_BLOCK).arrayBuffer());
              if (!block.length) throw new Error('file changed while sending');
            } catch (e) {
              e.unreadable = true;
              throw e;
            }
          }
          const from = offset - blockAt;
          const part = block.subarray(from, Math.min(from + CHUNK_SIZE, block.length));
          if (!sendRaw(conn, packChunk(slot, offset, part), via)) return;
          offset += part.length;
        }
        if (alive() && sendRaw(conn, JSON.stringify({ type: 'file-end', id: record.id, slot }), via)) t.endSentAt = Date.now();
      } finally {
        freeSlot(conn, slot);
      }
    } catch (e) {
      console.error('Send failed:', e);
      if (e && e.unreadable) {
        // The file itself can't be read (changed, moved, permission lost) - a
        // retry won't fix that, and every recipient is affected. Say so, so
        // their rows don't sit on "starting…" forever.
        for (const [tid, tt] of record.targets) {
          if (tt.done) continue;
          tt.declined = true;
          tt.failed = e.message;
          tt.gen++;
          sendToOne({ type: 'file-abort', id: record.id, to: tid, from: myId(), reason: e.message });
        }
        refreshSendRow(record);
        checkTransferComplete(record);
      }
    } finally {
      releaseStreamSlot();
    }
  }

  function waitForAck(record, ms) {
    return new Promise((resolve) => {
      const waiter = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        const i = record.ackWaiters.indexOf(waiter);
        if (i >= 0) record.ackWaiters.splice(i, 1);
        resolve(false);
      }, ms);
      record.ackWaiters.push(waiter);
    });
  }

  // One line under the file name: where it's going and how each recipient
  // is getting on - "To Alex · 45% · 12.3 MB/s", or per device when it was
  // sent to several.
  function sendSummaryText(record, speed = '') {
    const size = record.size || 1;
    const entries = [...record.targets].map(([tid, t]) => {
      let state;
      if (t.failed) state = `failed — ${t.failed}`;
      else if (t.declined) state = 'declined';
      else if (t.done) state = 'delivered';
      else if (!t.accepted) state = 'waiting for them to accept';
      else state = `${Math.min(99, Math.floor((t.acked / size) * 100))}%`;
      return [nameFor(tid), state];
    });
    if (entries.length === 1) return `To ${entries[0][0]} · ${entries[0][1]}${speed}`;
    return entries.map(([n, s]) => `${n}: ${s}`).join(' · ') + speed;
  }

  // The sender's bar shows what recipients have confirmed writing (like
  // PairDrop), not what's merely been handed to the network.
  function refreshSendRow(record) {
    let low = record.size;
    let active = false;
    for (const t of record.targets.values()) {
      if (t.accepted && !t.declined && !t.done) { low = Math.min(low, t.acked); active = true; }
    }
    updateTransferRow(record.row, low, record.size);
    setRowSub(record.row, sendSummaryText(record, active ? speedText(record.meter, low) : ''));
  }

  function checkTransferComplete(record) {
    if (![...record.targets.values()].every((t) => t.done || t.declined)) return;
    if (!outgoing.delete(record.id)) return;
    finishTransferRow(record.row, sendSummaryText(record), [...record.targets.values()].some((t) => t.failed));
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
    // Enter sends; Shift+Enter falls through to the default newline.
    // isComposing: don't fire on the Enter that confirms an IME candidate.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendTextMessage();
    }
  });

  // No cap on how much text you can send. One message can't be arbitrarily
  // big (a data channel carries ~256KB per message, the relay 1MB), so long
  // text goes out as numbered parts that the receiver stitches back together.
  const TEXT_PART = 16000; // UTF-16 units; at most 48KB on the wire
  const textParts = new Map(); // text id -> { parts: [], got, at } while one is arriving
  let sendingText = false;

  async function sendTextMessage() {
    const text = textInput.value.trim();
    if (!text || !sendEnabled || sendingText) return;
    sendingText = true;
    try {
      const targets = getSelectedTargets();
      const count = Math.ceil(text.length / TEXT_PART);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      for (let i = 0; i < count; i++) {
        const msg = { type: 'text', text: text.slice(i * TEXT_PART, (i + 1) * TEXT_PART), from: myId(), targets };
        if (count > 1) Object.assign(msg, { id, part: i, parts: count });
        // Keep the text in the box if it didn't actually go anywhere.
        if (!sendOriginating(msg)) {
          setStatus(false, 'Not connected to the other device right now — your text was not sent.');
          return;
        }
        if (i % 32 === 31) await new Promise((r) => setTimeout(r)); // give the socket a breath on very long text
      }
      addTextLogEntry('You', text);
      textInput.value = '';
    } finally {
      sendingText = false;
    }
  }

  function receiveText(msg, originId) {
    if (!msg.parts) return addTextLogEntry(nameFor(originId), msg.text);
    let a = textParts.get(msg.id);
    if (!a) {
      a = { parts: new Array(msg.parts), got: 0, at: Date.now() };
      textParts.set(msg.id, a);
    }
    if (a.parts[msg.part] === undefined) { // parts can arrive out of order if the path switched mid-text
      a.parts[msg.part] = msg.text;
      a.got++;
    }
    if (a.got === msg.parts) {
      textParts.delete(msg.id);
      addTextLogEntry(nameFor(originId), a.parts.join(''));
    }
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
    copyBtn.addEventListener('click', () => copyText(text, copyBtn));

    item.appendChild(wrap);
    item.appendChild(copyBtn);
    textLog.prepend(item);
  }

  // ---------- incoming messages (+ forwarding to other devices, host only) ----------
  const UNICAST = new Set(['file-accept', 'file-decline', 'file-ack', 'file-received', 'file-pull', 'file-check', 'file-abort']);

  async function onControlMessage(fromId, event) {
    if (typeof event.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    const originId = msg.from || fromId;

    if (msg.type === 'text') {
      if (role === 'host') deliverFromHost(msg, fromId);
      if (amITarget(msg)) receiveText(msg, originId);
    } else if (msg.type === 'file-offer') {
      if (role === 'host') deliverFromHost(msg, fromId);
      if (amITarget(msg)) showOfferPrompt(msg, originId);
    } else if (UNICAST.has(msg.type)) {
      // `to`-addressed - the host passes through anything not meant for itself.
      if (role === 'host' && msg.to !== myId()) { relayToOne(msg); return; }
      handleUnicast(msg);
    } else if (msg.type === 'file-start') {
      if (role === 'host') {
        const fanoutIds = (msg.targets || []).filter((tid) => tid !== myId() && tid !== fromId);
        const fanoutTargets = [];
        for (const tid of fanoutIds) {
          const tConn = connections.get(tid);
          if (!tConn || !tConn.ready) continue;
          const destSlot = allocSlot(tConn);
          if (destSlot == null) continue;
          const via = tConn.mode; // this stream's path onward, pinned like the sender's
          fanoutTargets.push({ clientId: tid, slot: destSlot, via });
          sendRaw(tConn, JSON.stringify({ ...msg, slot: destSlot }), via);
        }
        let routeMap = relayRoutes.get(fromId);
        if (!routeMap) { routeMap = new Map(); relayRoutes.set(fromId, routeMap); }
        for (const old of routeMap.get(msg.slot) || []) { const c = connections.get(old.clientId); if (c) freeSlot(c, old.slot); }
        routeMap.set(msg.slot, fanoutTargets);
      }
      if (amITarget(msg)) beginReceive(msg, fromId, originId);
    } else if (msg.type === 'file-end') {
      if (role === 'host') {
        const routeMap = relayRoutes.get(fromId);
        const fanoutTargets = routeMap?.get(msg.slot);
        if (fanoutTargets) {
          for (const t of fanoutTargets) {
            const tConn = connections.get(t.clientId);
            if (tConn) {
              sendRaw(tConn, JSON.stringify({ ...msg, slot: t.slot }), t.via);
              freeSlot(tConn, t.slot);
            }
          }
          routeMap.delete(msg.slot);
        }
      }
      const st = incoming.get(msg.id);
      if (st) finishReceive(st);
    }
  }

  // The `to`-addressed protocol messages that reach their destination.
  function handleUnicast(msg) {
    const record = outgoing.get(msg.id);
    const t = record?.targets.get(msg.from);

    switch (msg.type) {
      // ---- sender side ----
      case 'file-accept':
        if (!t || t.accepted || t.declined) return;
        t.accepted = true;
        refreshSendRow(record);
        serve(record, msg.from, 0);
        break;
      case 'file-decline':
        if (!t) return;
        t.declined = true;
        t.gen++;
        refreshSendRow(record);
        checkTransferComplete(record);
        break;
      case 'file-ack':
        if (!t) return;
        t.acked = Math.max(t.acked, msg.received);
        for (const w of record.ackWaiters.splice(0)) w();
        refreshSendRow(record);
        break;
      case 'file-received':
        if (!t) return;
        t.done = true;
        t.gen++;
        refreshSendRow(record);
        checkTransferComplete(record);
        break;
      case 'file-pull':
        // Receiver-driven resume. A pull that arrives while this recipient's
        // stream is still waiting for a free slot changes nothing.
        if (!t || t.done || t.declined || t.queued) return;
        if (!t.accepted) { // the accept itself was lost - asking for the bytes says the same thing
          t.accepted = true;
          refreshSendRow(record);
        }
        serve(record, msg.from, Math.max(0, Math.min(Number(msg.offset) || 0, record.size)));
        break;

      // ---- receiver side ----
      case 'file-abort': {
        // The sender gave up on this file (it can no longer read it).
        const why = `the sender couldn't read this file${msg.reason ? ` (${msg.reason})` : ''}`;
        const st = incoming.get(msg.id);
        if (st) {
          incoming.delete(msg.id);
          try { st.writable?.abort(); } catch (e) {}
          finishTransferRow(st.row, `From ${nameFor(st.from)} · ${why}`, true);
        }
        const offer = pendingIncoming.get(msg.id);
        if (offer) {
          pendingIncoming.delete(msg.id);
          offer.row.remove();
          updateOfferBar();
          renderOfferDialog();
        }
        break;
      }
      case 'file-check': {
        // The sender is waiting on a confirmation that may have been lost.
        const st = incoming.get(msg.id);
        if (st) finishReceive(st);
        else if (completedReceives.has(msg.id)) sendToOne({ type: 'file-received', id: msg.id, to: msg.from, from: myId() });
        break;
      }
    }
  }

  // ---------- accept / decline ----------
  function showOfferPrompt(msg, originId) {
    // The sender re-sends an unanswered offer every few seconds (it may have
    // been lost mid-reconnect) - show it once.
    if (pendingIncoming.has(msg.id) || incoming.has(msg.id) || completedReceives.has(msg.id)) return;
    if (declinedIds.has(msg.id)) { // our decline got lost - say it again instead of asking the user twice
      sendToOne({ type: 'file-decline', id: msg.id, to: originId, from: myId() });
      return;
    }

    // The row in the Transfers list is the standing record of the offer (it
    // keeps its own Accept/Decline); the dialog below is the prompt.
    const row = document.createElement('div');
    row.className = 'transfer-item offer';
    row.dataset.id = msg.id;
    row.innerHTML = `
      <div class="meta">
        <span class="name">↓ ${escapeHtml(msg.path || msg.name)}</span>
        <span class="size">${formatBytes(msg.size)}</span>
      </div>
      <div class="sub">From ${escapeHtml(nameFor(originId))} · waiting for you</div>
      <div class="offer-actions">
        <button class="secondary small accept-btn">Accept</button>
        <button class="ghost small decline-btn">Decline</button>
      </div>
    `;
    transferList.prepend(row);
    const offer = { msg, originId, row };
    pendingIncoming.set(msg.id, offer);
    updateOfferBar();
    queueOffer(offer);

    row.querySelector('.accept-btn').addEventListener('click', () => acceptOffer(offer));
    row.querySelector('.decline-btn').addEventListener('click', () => declineOffer(offer));
  }

  function declineOffer(offer) {
    if (!pendingIncoming.delete(offer.msg.id)) return;
    declinedIds.add(offer.msg.id);
    sendToOne({ type: 'file-decline', id: offer.msg.id, to: offer.originId, from: myId() });
    offer.row.remove();
    updateOfferBar();
    renderOfferDialog();
  }

  // Any picker (Save As / choose folder) has to open inside the click that
  // started this, or the browser refuses it - so it happens here, before the
  // accept goes out, not later when the first bytes show up. Returns a
  // writable stream to write straight to disk, or null for a normal download.
  //   - a batch (several files, or anything inside a folder) asks for one
  //     folder, once, and everything streams into it;
  //   - a lone big file gets a Save As; smaller ones just download.
  async function openWritable(msg, intoFolder) {
    const path = msg.path || msg.name;
    const nested = path.includes('/');
    if ((nested || intoFolder) && window.showDirectoryPicker) {
      if (!saveDirHandle) saveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const parts = path.split('/');
      const fileName = parts.pop();
      let dir = saveDirHandle;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      return (await dir.getFileHandle(await freeName(dir, fileName), { create: true })).createWritable();
    }
    if (!nested && msg.size >= STREAM_TO_DISK_MIN && window.showSaveFilePicker) {
      return (await window.showSaveFilePicker({ suggestedName: path })).createWritable();
    }
    return null;
  }

  // Never overwrite something already in the folder: "a.jpg" -> "a (1).jpg".
  async function freeName(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; ; i++) {
      const candidate = i ? `${stem} (${i})${ext}` : name;
      try {
        await dir.getFileHandle(candidate);
      } catch (e) {
        if (e && e.name === 'NotFoundError') return candidate;
        throw e;
      }
    }
  }

  // Resolves false only if the user cancelled a save dialog (the offer then
  // stays waiting for another try).
  async function acceptOffer(offer, intoFolder = false) {
    if (offer.busy || !pendingIncoming.has(offer.msg.id)) return true;
    offer.busy = true;
    let writable = null;
    try {
      writable = await openWritable(offer.msg, intoFolder);
    } catch (e) {
      if (e && e.name === 'AbortError') { offer.busy = false; return false; }
      console.warn('Falling back to a normal download:', e); // no permission, odd path...
    }
    if (!pendingIncoming.delete(offer.msg.id)) { // declined while the dialog was open
      try { writable?.abort(); } catch (e) {}
      return true;
    }
    updateOfferBar();
    renderOfferDialog(); // answered from the list instead of the dialog: close it if that was the last one
    createIncoming(offer.msg, offer.originId, offer.row, writable);
    sendToOne({ type: 'file-accept', id: offer.msg.id, to: offer.originId, from: myId() });
    return true;
  }

  function updateOfferBar() {
    const n = pendingIncoming.size;
    offerBar.classList.toggle('hidden', n < 2);
    offerBarText.textContent = `${n} files waiting`;
    document.title = n && document.hidden ? `(${n}) Incoming — DropCode` : 'DropCode';
  }
  document.addEventListener('visibilitychange', updateOfferBar);

  acceptAllBtn.addEventListener('click', async () => {
    const offers = [...pendingIncoming.values()];
    for (const offer of offers) if (!(await acceptOffer(offer, offers.length > 1))) return;
  });
  declineAllBtn.addEventListener('click', () => {
    for (const offer of [...pendingIncoming.values()]) declineOffer(offer);
  });

  // ---------- the "incoming transfer" dialog ----------
  // Offers from one sender that arrive together - a multi-file or folder
  // drop - are gathered into ONE dialog rather than a prompt per file. Closing
  // it without answering (Esc, click outside) just leaves the offers waiting
  // in the Transfers list, with their own buttons.
  const offerGroups = []; // { originId, offers: [offer], showAt }
  let activeGroup = null;
  let showTimer = null;
  const livePending = (g) => g.offers.filter((o) => pendingIncoming.get(o.msg.id) === o);

  function queueOffer(offer) {
    let g = offerGroups.find((x) => x.originId === offer.originId);
    if (!g) {
      g = { originId: offer.originId, offers: [], showAt: Date.now() + 400 }; // let the rest of a burst arrive first
      offerGroups.push(g);
    }
    g.offers.push(offer);
    if (g === activeGroup) renderOfferDialog();
    else showNextGroup();
  }

  function showNextGroup() {
    if (offerDialog.open) return;
    while (offerGroups.length) {
      const g = offerGroups[0];
      if (!livePending(g).length) { offerGroups.shift(); continue; }
      const wait = g.showAt - Date.now();
      if (wait > 0) {
        clearTimeout(showTimer);
        showTimer = setTimeout(showNextGroup, wait + 20);
        return;
      }
      activeGroup = g;
      renderOfferDialog();
      offerDialog.showModal();
      return;
    }
  }

  // What will happen to the bytes - said plainly, because it depends on the
  // browser (and on whether the page is https/localhost, which is what
  // unlocks writing straight to disk).
  function saveNote(offers) {
    const total = offers.reduce((n, o) => n + (o.msg.size || 0), 0);
    const batch = offers.length > 1 || offers.some((o) => (o.msg.path || '').includes('/'));
    if (batch && window.showDirectoryPicker) {
      return saveDirHandle ? 'Saved straight into the folder you chose earlier.' : "You'll pick a folder once — files are written straight to disk as they arrive, whatever the size.";
    }
    if (!batch && offers[0].msg.size >= STREAM_TO_DISK_MIN && window.showSaveFilePicker) {
      return "You'll choose where to save it — it's written straight to disk as it arrives, whatever the size.";
    }
    if (total > 1024 ** 3) {
      return 'Goes to your Downloads folder when it finishes. This browser holds the data while it arrives, so keep this tab open and leave enough free disk space.';
    }
    return batch ? 'Each file downloads to your Downloads folder.' : 'Saved to your Downloads folder.';
  }

  function renderOfferDialog() {
    const offers = activeGroup ? livePending(activeGroup) : [];
    if (!offers.length) {
      if (offerDialog.open) offerDialog.close();
      return;
    }
    const total = offers.reduce((n, o) => n + (o.msg.size || 0), 0);
    offerTitle.textContent = nameFor(activeGroup.originId);
    offerSub.textContent = `wants to send you ${offers.length === 1 ? '1 file' : `${offers.length.toLocaleString()} files`} · ${formatBytes(total)}`;
    const shown = offers.slice(0, 40); // the list is a preview; the transfer itself has no such cap
    offerFiles.innerHTML =
      shown.map((o) => `<li><span class="fname">${escapeHtml(o.msg.path || o.msg.name)}</span><span class="fsize">${formatBytes(o.msg.size)}</span></li>`).join('') +
      (offers.length > shown.length ? `<li class="more">and ${(offers.length - shown.length).toLocaleString()} more…</li>` : '');
    offerNote.textContent = saveNote(offers);
    offerAcceptBtn.firstElementChild.textContent = offers.length > 1 ? `Accept ${offers.length.toLocaleString()} files` : 'Accept';
  }

  offerAcceptBtn.addEventListener('click', async () => {
    if (!activeGroup) return;
    const offers = livePending(activeGroup);
    for (const o of offers) if (!(await acceptOffer(o, offers.length > 1))) return; // cancelled a dialog: stay open
    if (offerDialog.open) offerDialog.close();
  });
  offerDeclineBtn.addEventListener('click', () => {
    if (activeGroup) for (const o of livePending(activeGroup)) declineOffer(o);
    if (offerDialog.open) offerDialog.close();
  });
  offerDialog.addEventListener('click', (e) => { if (e.target === offerDialog) offerDialog.close(); }); // the backdrop
  offerDialog.addEventListener('close', () => {
    const i = offerGroups.indexOf(activeGroup);
    if (i >= 0) offerGroups.splice(i, 1);
    activeGroup = null;
    showNextGroup();
  });

  // ---------- receiving ----------
  function createIncoming(msg, originId, row, writable) {
    const st = {
      id: msg.id, name: msg.name, path: msg.path || msg.name, size: msg.size,
      from: originId, // who to confirm delivery to
      received: 0, // contiguous bytes taken in (the resume point)
      written: 0, // of those, bytes safely written - what acks report
      acked: 0,
      writable, // FileSystemWritableFileStream, when streaming to disk
      chunks: [], bufBytes: 0, parts: [], // buffered path: recent chunks + Blob-folded older ones
      row, lastActivity: Date.now(), lastPull: 0, finishing: false, meter: {},
    };
    incoming.set(st.id, st);
    if (row) {
      row.classList.remove('offer');
      setRowSub(row, `From ${nameFor(originId)} · starting…`);
      const actions = row.querySelector('.offer-actions');
      if (actions) actions.outerHTML = '<div class="progress-track"><div class="progress-fill"></div></div>';
    } else {
      st.row = addTransferRow(st.id, st.path, st.size, 'receiving');
    }
    return st;
  }

  function beginReceive(msg, fromId, originId) {
    if (completedReceives.has(msg.id)) {
      // The sender is (re)sending something we already have - its confirmation was lost.
      sendToOne({ type: 'file-received', id: msg.id, to: originId, from: myId() });
      return;
    }
    // An id we never accepted (e.g. this tab was reloaded mid-transfer) just
    // becomes a fresh buffered download.
    const st = incoming.get(msg.id) || createIncoming(msg, originId, pendingIncoming.get(msg.id)?.row, null);
    pendingIncoming.delete(msg.id);
    setActiveSlot(fromId, msg.slot, st.id);
    st.lastActivity = Date.now();
  }

  function onFileChunk(fromId, event) {
    const raw = event.data;
    if (typeof raw === 'string' || !raw || raw.byteLength <= HEADER) return;
    const { slot, offset, payload } = unpackChunk(raw);

    if (role === 'host') {
      const routes = relayRoutes.get(fromId)?.get(slot);
      if (routes) {
        for (const t of routes) {
          const tConn = connections.get(t.clientId);
          if (tConn) sendRaw(tConn, reslot(raw, t.slot), t.via);
        }
      }
    }

    const st = incoming.get(getActiveSlot(fromId, slot));
    if (st) receiveBytes(st, offset, payload);
  }

  async function receiveBytes(st, offset, bytes) {
    if (offset > st.received) { // a gap: drop it and ask the sender to restart at st.received (1/s - the rest of the old stream is still draining)
      if (!st.finishing && Date.now() - st.lastPull > 1000) pullFrom(st);
      return;
    }
    const skip = st.received - offset;
    if (skip >= bytes.length) return; // already have all of it
    const data = skip ? bytes.subarray(skip) : bytes;
    st.received += data.length;
    st.lastActivity = Date.now();

    try {
      if (st.writable) {
        await st.writable.write(data);
      } else {
        st.chunks.push(data);
        st.bufBytes += data.length;
        if (st.bufBytes >= BLOB_PART_SIZE) {
          // A Blob lives in the browser's blob store (which can spill to disk)
          // instead of the JS heap - a multi-GB buffered receive survives.
          st.parts.push(new Blob(st.chunks));
          st.chunks = [];
          st.bufBytes = 0;
        }
      }
    } catch (e) {
      return failReceive(st, e);
    }

    st.written += data.length;
    if (st.written - st.acked >= ACK_EVERY) {
      st.acked = st.written;
      sendToOne({ type: 'file-ack', id: st.id, to: st.from, from: myId(), received: st.written });
    }
    updateTransferRow(st.row, st.received, st.size);
    const pct = st.size ? Math.min(99, Math.floor((st.received / st.size) * 100)) : 99;
    setRowSub(st.row, `From ${nameFor(st.from)} · ${pct}%${speedText(st.meter, st.received)}`);
  }

  function pullFrom(st) {
    st.lastPull = st.lastActivity = Date.now();
    sendToOne({ type: 'file-pull', id: st.id, to: st.from, from: myId(), offset: st.received });
  }

  async function finishReceive(st) {
    if (st.finishing) return;
    // Complete means exactly every byte. If the sender says it's done but
    // something went missing, ask for the rest rather than save (and
    // confirm!) a truncated file.
    if (st.received < st.size) return pullFrom(st);
    st.finishing = true;
    try {
      if (st.writable) await st.writable.close();
      else saveBlob(new Blob([...st.parts, ...st.chunks], { type: 'application/octet-stream' }), st.path);
    } catch (e) {
      st.finishing = false;
      return failReceive(st, e);
    }
    finishTransferRow(st.row, `From ${nameFor(st.from)} · ${st.writable ? 'saved to disk' : 'downloaded'}`);
    completedReceives.add(st.id);
    incoming.delete(st.id);
    // Tell the sender it can mark this done - it can't know from having sent the bytes.
    sendToOne({ type: 'file-received', id: st.id, to: st.from, from: myId() });
  }

  function saveBlob(blob, path) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.includes('/') ? path.replace(/\//g, '__') : path;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // The disk write (or the save) failed - tell the sender to stop rather
  // than leave it streaming into a receiver that can no longer keep up.
  function failReceive(st, e) {
    console.error('Receive failed:', e);
    incoming.delete(st.id);
    try { st.writable?.abort(); } catch (e2) {}
    finishTransferRow(st.row, `From ${nameFor(st.from)} · failed to save — ${e && e.message ? e.message : e}`, true);
    declinedIds.add(st.id);
    sendToOne({ type: 'file-decline', id: st.id, to: st.from, from: myId() });
  }

  // ---------- recovery tick ----------
  // Receiver: nothing arrived for a while -> pull from what we have.
  // Sender: nudge unanswered offers, ask whether a finished stream landed,
  // and give up on offers to devices that left the room.
  // A connection just became usable (or switched path after a loss): pull on
  // every receive that travels over it - everyone else's streams are untouched.
  function onConnectionReady(connId) {
    for (const st of incoming.values()) {
      const wireId = role === 'host' ? st.from : hostClientId;
      if (wireId === connId && !st.finishing && Date.now() - st.lastPull > 1000) pullFrom(st);
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [id, a] of textParts) if (now - a.at > 120000) textParts.delete(id); // a text that never finished arriving
    for (const st of incoming.values()) {
      if (!st.finishing && now - st.lastActivity > PULL_AFTER_MS) pullFrom(st);
    }
    for (const record of [...outgoing.values()]) {
      for (const [tid, t] of record.targets) {
        if (t.done || t.declined) continue;
        if (!t.accepted) {
          if (roster.some((d) => d.id === tid)) t.missingSince = 0;
          else if (!t.missingSince) t.missingSince = now;
          else if (now - t.missingSince > OFFER_GONE_MS) { t.declined = true; continue; }
          if (now - t.lastOffer > OFFER_RETRY_MS) {
            t.lastOffer = now;
            sendOriginating(offerMsg(record, [tid]));
          }
        } else if (t.endSentAt && now - t.endSentAt > CHECK_EVERY_MS) {
          t.endSentAt = now;
          sendToOne({ type: 'file-check', id: record.id, to: tid, from: myId() });
        }
      }
      checkTransferComplete(record);
    }
  }, TICK_MS);

  // Closing the tab mid-transfer is the most common way to lose one.
  window.addEventListener('beforeunload', (e) => {
    const sending = [...outgoing.values()].some((r) => [...r.targets.values()].some((t) => t.accepted && !t.done && !t.declined));
    if (incoming.size || sending) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- transfer list UI ----------
  function addTransferRow(id, name, size, direction, sub = '') {
    const row = document.createElement('div');
    row.className = 'transfer-item';
    row.dataset.id = id;
    row.innerHTML = `
      <div class="meta">
        <span class="name">${direction === 'sending' ? '↑' : '↓'} ${escapeHtml(name)}</span>
        <span class="size">${formatBytes(size)}</span>
      </div>
      <div class="sub">${escapeHtml(sub)}</div>
      <div class="progress-track"><div class="progress-fill"></div></div>
    `;
    transferList.prepend(row);
    return row;
  }

  function updateTransferRow(row, received, size) {
    if (!row) return;
    const pct = size ? Math.min(100, (received / size) * 100) : 100;
    const fill = row.querySelector('.progress-fill');
    if (fill) fill.style.transform = `scaleX(${pct / 100})`;
  }

  function setRowSub(row, text) {
    const el = row?.querySelector('.sub');
    if (el && el.textContent !== text) el.textContent = text;
  }

  function finishTransferRow(row, sub, failed = false) {
    if (!row) return;
    row.classList.add('done');
    row.classList.toggle('failed', failed);
    const fill = row.querySelector('.progress-fill');
    if (fill) fill.style.transform = 'scaleX(1)';
    if (sub != null) setRowSub(row, sub);
    clearDoneBtn.classList.remove('hidden');
  }

  clearDoneBtn.addEventListener('click', () => {
    for (const row of transferList.querySelectorAll('.transfer-item.done')) row.remove();
    clearDoneBtn.classList.add('hidden');
  });

  // Rolling bytes/second for a row's status line: re-sampled at most about
  // once a second so the number is readable rather than flickering.
  function speedText(meter, bytes) {
    const now = performance.now();
    if (!meter.t) { meter.t = now; meter.b = bytes; return ''; }
    if (now - meter.t >= 800) {
      meter.s = ((bytes - meter.b) / (now - meter.t)) * 1000;
      meter.t = now;
      meter.b = bytes;
    }
    return meter.s > 0 ? ` · ${formatBytes(meter.s)}/s` : '';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/"/g, '&quot;'); // also safe inside an attribute
  }
})();
