// DropCode server
// - Serves the client app
// - Handles pairing (room codes) and relays WebRTC signaling.
// - Normally, once two devices are paired, file/folder/text data flows
//   directly between browsers over a WebRTC data channel (peer-to-peer) -
//   this server never sees it, and there's no size limit it imposes.
// - If a direct WebRTC connection can't be established (a VPN or firewall
//   commonly blocks it outright), the client falls back to relaying that
//   one connection's data through this server instead (see the 'relay'
//   handler below) so the transfer still works. That fallback data IS
//   readable by this server - it's the same tradeoff PairDrop's optional
//   WS_FALLBACK makes, for the same reason.
//
// Identity: every browser tab generates its own stable `clientId` (see
// public/app.js) that survives a reload AND a bare network reconnect -
// unlike socket.id, which changes every time the underlying connection
// drops and comes back. Rooms are keyed by clientId so a device that
// blips and reconnects is recognized as the SAME device (and can resume
// an in-flight transfer) instead of showing up as a stranger while its
// old connection slowly times out.

const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3005;

app.use(express.static('public'));

// Tells the client the address it should show as the shareable "Link" -
// NOT window.location.href, which is wrong whenever the host happened to
// open the page via "localhost" (or any address other than the one a
// friend on the network can actually reach).
app.get('/api/network-info', (req, res) => {
  const candidates = getAllCandidates();
  res.json({ address: candidates[0]?.address || null, port: Number(PORT) });
});

// code -> { hostClientId, hostSocketId, peers: Map<clientId, socketId>,
//           devices: Map<clientId, name>, graceTimer }
// A room supports one host plus any number of peers, all sharing the same
// code for as long as the host keeps sharing. Each peer talks directly to
// the host over its own WebRTC connection (a "star" topology) - the host
// then relays anything it receives out to every other connected peer, so
// a group of devices can all share with each other through one code.
//
// If the host's page reloads or its connection blips, hostSocketId goes
// null but the room, code, and hostClientId are kept alive for
// HOST_GRACE_MS in case the host comes back via 'host-resume'. Only after
// that window passes without a resume do peers get 'host-left' and the
// room is torn down for good.
const rooms = new Map();
const HOST_GRACE_MS = 20000;

// Broadcasts the current device roster (id, display name, host flag) to
// everyone in the room - the client uses this for naming and for the
// "send to specific devices" target picker. `id` is the stable clientId,
// not a socket id, so it stays the same across a device's reconnects.
function broadcastRoster(code) {
  const room = rooms.get(code);
  if (!room) return;
  const list = [...room.devices.entries()].map(([id, name]) => ({ id, name, isHost: id === room.hostClientId }));
  io.to(code).emit('roster', list);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Rank candidate addresses so a real Wi-Fi/LAN IP (192.168.x.x, 10.x.x.x,
// 172.16-31.x.x) is preferred over a link-local/APIPA address (169.254.x.x),
// which shows up when an adapter never got a real DHCP address, or when a
// VPN/virtual adapter (Docker, Hyper-V, VirtualBox, etc.) gets picked
// instead of the actual Wi-Fi card.
function score(ip) {
  if (/^169\.254\./.test(ip)) return 2; // link-local - last resort
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 0; // typical LAN
  return 1; // anything else (public IP, unusual private range, etc.)
}

function getAllCandidates() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        list.push({ name, address: iface.address });
      }
    }
  }
  return list.sort((a, b) => score(a.address) - score(b.address));
}

function safeName(name, fallback) {
  return String(name || '').slice(0, 40) || fallback;
}

io.on('connection', (socket) => {
  socket.on('host-start', (clientId, name, cb) => {
    clientId = String(clientId || '').slice(0, 100);
    if (!clientId) return cb({ error: 'Missing client id.' });
    const code = generateCode();
    const room = { hostClientId: clientId, hostSocketId: socket.id, peers: new Map(), devices: new Map(), graceTimer: null };
    room.devices.set(clientId, safeName(name, 'Host'));
    rooms.set(code, room);
    socket.data.code = code;
    socket.data.role = 'host';
    socket.data.clientId = clientId;
    socket.join(code);
    cb({ code });
    broadcastRoster(code);
  });

  // Used after the host's page reloads, or its connection drops and comes
  // back: reclaim the same code instead of generating a new one, as long
  // as it's still the SAME logical device (clientId) and the room's grace
  // window hasn't expired. Returns the peers already in the room (with
  // their current socket ids) so the host can reconnect to each of them.
  socket.on('host-resume', (code, clientId, name, cb) => {
    code = String(code || '').toUpperCase().trim();
    clientId = String(clientId || '').slice(0, 100);
    const room = rooms.get(code);
    if (!room || room.hostClientId !== clientId) return cb({ ok: false });

    clearTimeout(room.graceTimer);
    room.graceTimer = null;
    room.hostSocketId = socket.id;
    room.devices.set(clientId, safeName(name, 'Host'));
    socket.data.code = code;
    socket.data.role = 'host';
    socket.data.clientId = clientId;
    socket.join(code);
    cb({ ok: true, code, peers: [...room.peers].map(([cid, sid]) => ({ clientId: cid, socketId: sid })) });

    // Tell every peer the host is back and which socket to reach it at. A
    // relayed connection never sends a 'signal' message a peer could
    // otherwise notice this from, so this explicit nudge is what gets
    // them to reconnect (or just repoint an already-fine relay at it).
    socket.to(code).emit('host-reconnected', { hostClientId: clientId, hostSocketId: socket.id });
    broadcastRoster(code);
  });

  socket.on('join-room', (code, clientId, name, cb) => {
    code = String(code || '').toUpperCase().trim();
    clientId = String(clientId || '').slice(0, 100);
    const room = rooms.get(code);
    if (!room) {
      return cb({
        error: `Code ${code} was not found. Make sure you're using the code currently shown on the host's screen — it changes every time "Start Sharing" is clicked.`,
      });
    }
    if (!clientId) return cb({ error: 'Missing client id.' });

    const reconnecting = room.peers.has(clientId); // same device rejoining after a blip, not a stranger
    room.peers.set(clientId, socket.id);
    room.devices.set(clientId, safeName(name, reconnecting ? room.devices.get(clientId) : `Device ${room.devices.size}`));
    socket.data.code = code;
    socket.data.role = 'peer';
    socket.data.clientId = clientId;
    socket.join(code);
    cb({ ok: true, hostClientId: room.hostClientId, hostSocketId: room.hostSocketId });

    // The host opens (or repoints) a dedicated connection to this peer.
    // Existing peers are untouched - they already have their own connection.
    // (If the host is mid-reconnect itself, hostSocketId is briefly null -
    // this peer will be picked up once 'host-resume' fires.)
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('peer-joined', { peerClientId: clientId, peerSocketId: socket.id, reconnecting });
    }
    broadcastRoster(code);
  });

  // Lets a device rename itself at any point during a session.
  socket.on('rename', (name) => {
    const code = socket.data.code;
    const room = code && rooms.get(code);
    if (!room || !socket.data.clientId) return;
    room.devices.set(socket.data.clientId, safeName(name, 'Device'));
    broadcastRoster(code);
  });

  // Signaling is point-to-point: every message names its target socket
  // (`to`), so it's routed to exactly one live connection even when
  // several peers share a room. `fromClientId` rides along so the
  // recipient can match this against its own stable connection bookkeeping
  // even though the sender's socket id may have changed since last time.
  socket.on('signal', (data) => {
    if (!data || !data.to) return;
    socket.to(data.to).emit('signal', { ...data, from: socket.id, fromClientId: socket.data.clientId });
  });

  // Fallback relay: used only when a direct WebRTC connection can't be
  // established (a VPN or firewall commonly blocks the peer-to-peer
  // handshake outright). In that case file/text data is passed through
  // here instead - meaning this data IS readable by this server, unlike
  // a normal WebRTC transfer. See public/app.js for when this kicks in.
  socket.on('relay', (data) => {
    if (!data || !data.to) return;
    socket.to(data.to).emit('relay', { from: socket.id, fromClientId: socket.data.clientId, payload: data.payload });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.role === 'host') {
      // A newer socket may have already resumed this same host identity
      // (a fast reconnect racing this stale socket's disconnect) - if so,
      // this disconnect is stale news and must not tear down the fresh one.
      if (room.hostSocketId !== socket.id) return;
      // Don't tear the room down immediately - a reload/blip looks
      // identical to a real disconnect at this point. Give the host
      // HOST_GRACE_MS to come back with the same code via 'host-resume'
      // before ending the session for everyone in it.
      room.hostSocketId = null;
      io.to(code).emit('host-disconnected'); // immediate, non-terminal - "reconnecting", not "ended"
      room.graceTimer = setTimeout(() => {
        io.to(code).emit('host-left');
        rooms.delete(code);
      }, HOST_GRACE_MS);
      broadcastRoster(code);
    } else if (socket.data.role === 'peer') {
      const clientId = socket.data.clientId;
      // Same race as above: only remove this peer if this socket is still
      // its current one (a fast rejoin may have already superseded it).
      if (!clientId || room.peers.get(clientId) !== socket.id) return;
      room.peers.delete(clientId);
      room.devices.delete(clientId);
      if (room.hostSocketId) io.to(room.hostSocketId).emit('peer-left', { peerClientId: clientId });
      broadcastRoster(code);
    }
  });
});

server.listen(PORT, () => {
  const candidates = getAllCandidates();
  console.log('');
  console.log('  DropCode is running.');
  console.log('');
  console.log(`  On this machine:  http://localhost:${PORT}`);

  if (candidates.length === 0) {
    console.log('  Could not detect any network address - check your Wi-Fi connection.');
  } else {
    const best = candidates[0];
    console.log(`  On your network:  http://${best.address}:${PORT}   <-- share this link with your friend (same Wi-Fi/LAN)`);

    if (candidates.length > 1) {
      console.log('');
      console.log('  Found more than one network adapter. If the link above doesn\'t');
      console.log('  work for your friend, try one of these instead:');
      for (const c of candidates.slice(1)) {
        console.log(`    http://${c.address}:${PORT}   (${c.name})`);
      }
    }
    if (/^169\.254\./.test(best.address)) {
      console.log('');
      console.log('  Warning: the best address found is a link-local (169.254.x.x)');
      console.log('  address, which usually means Wi-Fi never got a real IP from your');
      console.log('  router. Run "ipconfig" (Windows) or "ifconfig"/"ip addr" (Mac/Linux)');
      console.log('  to find your Wi-Fi adapter\'s real IPv4 address and use that instead.');
    }
  }
  console.log('');
});
