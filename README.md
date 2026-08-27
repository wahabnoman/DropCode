# DropCode

Your own AirDrop/PairDrop-style sharing tool: no size limits, no account,
files go directly between browsers over WebRTC whenever possible. If a
direct connection can't be made (a VPN or firewall commonly blocks WebRTC
outright), it automatically falls back to relaying through this server —
the same tradeoff PairDrop's `WS_FALLBACK` makes, and for the same reason.
See "If a device won't connect" below.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (this was built and tested on Node 22).

## Run it

```bash
cd dropcode
npm install
npm start
```

You'll see something like:

```
On this machine:  http://localhost:3005
On your network:  http://192.168.1.42:3005   <-- share this link with your friend
```

(Default port is 3005. Override it with `PORT=3005 npm start` → any port you want, e.g. `PORT=8080 npm start`.)

1. Open the **On your network** link yourself, optionally type a **device
   name** for yourself (e.g. "Alex's Laptop" — otherwise you get a generic
   one), and click **Start Sharing**. A 6-character code appears.
2. Send that same link + the code to your friend (chat, text, whatever) —
   they need to be on the **same Wi-Fi/LAN** as your laptop for this to work
   out of the box.
3. They open the link, type the code into the **Join** box, click **Connect**.
4. Once it shows "Connected", either side can drag & drop files or a whole
   folder, or type text — drop several files or a big folder at once and
   they all start sending right away instead of waiting in line. The
   **other device(s)** are listed as checkable pills — leave them all
   checked to send to everyone, or uncheck the ones you don't want this
   send to go to. Whoever it's aimed at gets an **Accept / Decline** prompt
   before anything actually transfers to them.

The link is "fixed" in the sense that it's always the same address as long
as your laptop's IP doesn't change — you generate a fresh pairing code each
time you click "Start Sharing", so old codes can't be reused after you stop
sharing.

### Connecting more than one friend

The same code works for as many devices as you want to invite — just keep
sharing the same code and link with everyone. Everyone who joins shows up as
a pill on every other device's screen (host and friends alike), labeled with
whatever device name they picked. By default a send goes to everyone in the
session, so it still works as a shared drop for a small group, not just a
1:1 pairing — but you can uncheck specific pills before sending to reach
only some of them. If your laptop (the host) closes the page or disconnects,
the whole session ends for everyone; if one friend leaves, everyone else
stays connected.

### Naming your device

Type a name in **Your device name** before you start/join — it's what
everyone else sees in their device list. It's remembered on that browser
for next time. You can also change it mid-session under **You are:** in the
session screen; the new name shows up for everyone immediately.

### Accepting or declining a transfer

Nobody receives a file, folder, or piece of text without a chance to say no
first. When something is sent to you (or to a group you're part of), it
shows up in your Transfers list as a pending offer with **Accept** and
**Decline** buttons — nothing streams until you click Accept. If you
decline, the sender sees the item marked "(declined)" and nothing was sent.

### Sending several things at once

Drop 5 files, or a folder with hundreds of files in it, and every offer
goes out immediately instead of waiting for the previous one to finish —
accept them in any order, and up to a few move at once (more than that
just queues briefly rather than fighting each other for bandwidth). This
also means a folder full of files doesn't stall behind one big file dropped
alongside it.

## Relay mode (on by default)

**"Always relay through this server" is checked by default** on both the
Host and Join cards. This means every connection routes through your own
DropCode server rather than attempting a direct peer-to-peer WebRTC link
first — the default was switched to this after direct WebRTC connections
proved unreliable across some laptops even on the same Wi-Fi (most often
because a VPN client or a firewall policy blocks the WebRTC handshake
outright, which is exactly the mechanism PairDrop's `WS_FALLBACK` exists to
work around). Relaying connects reliably every time, at the cost of no
longer being strictly peer-to-peer.

You'll always be able to tell when relay is active: the connection status
says "(relayed via server)" and the device's chip on the host's screen
says "(relayed)" — DropCode never silently pretends a relayed connection
is peer-to-peer.

**Important tradeoff:** a relayed connection's data passes through your
own DropCode server (still just your laptop, not a third party) instead of
going directly between the two browsers.

**To try a direct peer-to-peer connection instead** (faster, and this
server never sees the data), uncheck "Always relay through this server" on
a device before starting/joining. If a direct connection can't be
established within about 6 seconds, that one device automatically falls
back to relaying anyway, so unchecking it never leaves you stuck.

## Surviving a page refresh — or a dropped connection

If either the host's or a friend's browser tab reloads, or the network
just blips (Wi-Fi hiccup, laptop sleeps and wakes, a VPN reconnects),
DropCode reconnects automatically — nobody has to re-enter a code, and a
transfer that was in progress keeps going instead of failing outright:

- **If the host's page reloads**, it reclaims the *same* code (rather than
  generating a new one) as long as it comes back within about 20 seconds,
  and automatically reconnects to every device that was already joined.
  Friends see "Host disconnected — waiting for it to reconnect..." during
  that window, not a hard "session ended."
- **If a friend's page reloads**, it automatically rejoins the same
  session using the code it remembers — nothing to retype.
- **If the connection just drops without a reload** (a brief network
  interruption), both sides keep retrying in the background — quickly at
  first, backing off up to every 15 seconds — until it's back, with no
  action needed from anyone.
- If the host doesn't come back within that ~20 second window, the session
  really does end and everyone is told so.

**A transfer that was in progress when the connection dropped resumes from
where it left off**, not from scratch — each side asks the other "how much
of this do you actually have" before continuing, so even an imprecisely-
timed drop can't duplicate or corrupt bytes. This works for any direct
connection (host ↔ any device). For a file relayed peer-to-peer through the
host (a 3+ device group send where neither side is the host), only the
leg that actually dropped needs to reconnect for the whole thing to keep
flowing; if you want to be certain a transfer survives a bad connection,
sending directly from/to the host is the most robust path.

This is about the *connection* recovering — closing the tab entirely (not
just reloading it) still ends anything in flight; there's no resume across
that.

## Notes on folders

- If the receiving browser supports the File System Access API (current
  Chrome/Edge), you'll be asked to pick a folder to save into, and files are
  streamed straight to disk with the original folder structure preserved —
  no memory limit, works for very large folders.
- On browsers without that API (Firefox, Safari), each file downloads
  individually into your normal Downloads folder, with the folder path
  baked into the filename (e.g. `Photos__2024__trip.jpg`) so nothing is lost.

## Making it work over the internet (not just the same Wi-Fi)

Right now, both people must be on the same network because the pairing
server only listens on your laptop. To let a friend connect from anywhere:

1. Deploy this same project to a small always-on host that has a public
   address — e.g. [Render](https://render.com), [Fly.io](https://fly.io),
   [Railway](https://railway.app), or a cheap VPS (DigitalOcean, Hetzner,
   etc.). No code changes needed — just `npm install && npm start` there
   too, with the platform's assigned `PORT` (the server already reads
   `process.env.PORT`).
2. That gives you a permanent public URL to use as your "fixed link"
   instead of your laptop's LAN address.
3. The actual file transfer still happens peer-to-peer over WebRTC — the
   hosted server only relays the pairing handshake, so your hosting costs
   stay tiny even for large transfers.
4. One caveat: WebRTC needs to punch through NAT/firewalls. The public
   STUN server already configured (`stun.l.google.com`) handles most home
   networks fine. If a connection ever fails to establish on a stricter
   network (e.g. corporate Wi-Fi), the fix is adding a TURN server (e.g. a
   free tier from [Metered](https://www.metered.ca/tools/openrelay/) or
   [Twilio](https://www.twilio.com/docs/stun-turn)) to the `ICE_SERVERS`
   list in `public/app.js` — not needed for same-network or typical home
   internet use.

## How it works (short version)

- `server.js` — Express + Socket.IO. Generates pairing codes and relays
  WebRTC offer/answer/ICE messages between the host and each joining
  device. It also relays actual file/text data, but only for a connection
  that has fallen back to relay mode (see above) — a normal peer-to-peer
  connection's data never passes through it.
- `public/app.js` — Every device connects directly to the host over its own
  `RTCPeerConnection` ("star" topology — friends don't connect to each
  other directly, only to the host). Each connection carries one ordered
  data channel used for both small JSON control messages (file offers,
  accept/decline, text) and the raw binary file chunks (16KB at a time,
  with backpressure handling so large files don't blow up memory) — or,
  once a connection has fallen back, the same messages sent through the
  Socket.IO connection instead. Every send names its intended recipient
  device id(s); when the host receives something meant for someone other
  than itself, it forwards it on to exactly those devices (over whichever
  transport each connection is using) instead of blindly broadcasting, so
  a group of 3+ people can share with each other — or with just one
  specific person — through one code, even when some of them are relayed.
  A file/folder transfer always starts with an offer that the recipient(s)
  must accept before any bytes move.
- The server keeps a small roster per room (`room.devices`, id → chosen
  name) and rebroadcasts it whenever someone joins, leaves, or renames —
  that's what powers the device list, naming, and target picker.
- Every browser tab has its own stable id (separate from Socket.IO's own
  connection id, which changes on every reconnect) that survives a reload
  and a network blip alike. Rooms, targets, and in-flight transfers are all
  keyed on that stable id, which is what makes a device that drops and
  comes back get recognized as the *same* device — instead of looking like
  a stranger while its old connection quietly times out - and lets a
  transfer resume instead of restarting.
- Several files can stream over one connection at once: each active
  transfer claims a small slot number, and every chunk is tagged with it so
  the receiver (or a relaying host) knows which file it belongs to.
- Folder drops are read recursively client-side and sent as a flat list of
  files with their relative paths, then reassembled on the other end.
- The "Link" shown to the host comes from a small `/api/network-info`
  endpoint reporting the address the server actually detected — not from
  the browser's current URL, which would be wrong (e.g. "localhost") if
  you happened to open the page that way yourself.
- A host's room isn't deleted the instant its socket disconnects; it's
  kept alive for `HOST_GRACE_MS` (20s) so a `host-resume` with the same
  code can reclaim it, which is what makes surviving a reload work.

## Known limitations of this MVP

- No TURN server bundled — see the internet-access section above if you
  hit a network that blocks direct peer connections.
- Resume works for a connection that drops and comes back; it does not
  work across closing the tab, or across the ~20 second host grace window
  expiring. Either of those ends any in-flight transfer for good.
- Reconnect attempts back off but never give up on their own while the tab
  stays open — if a network is down for good, that side just keeps quietly
  retrying every ~15 seconds. Clicking Disconnect stops it.
- There's no timeout on an in-flight "how much have you got" resume check
  either — if the other device is unreachable it just won't resume until it
  is, same as the accept/decline case below.
- With several devices connected, the host's browser does the work of
  relaying anything it receives out to everyone else — that's normal
  browser-tab memory/CPU, but very large fan-out to many devices at once
  will be somewhat limited by the host device's own performance.
- The relay fallback doesn't apply per-chunk backpressure the way a direct
  WebRTC data channel does, so a very large transfer over a relayed
  connection puts more load on the server than the same transfer would
  peer-to-peer. Fine for normal file/folder sizes; something to be aware of
  for very large batches on an underpowered host machine.
- A folder is offered and accepted one file at a time, not as a single
  bundle — expect an Accept prompt per file inside it.
- There's no timeout on an accept/decline prompt: if a targeted device
  never responds (closed tab, etc.), the sender just waits for it. Removing
  that device from the target list before sending avoids this.

---

**// Designed by Wahab //**
#   D r o p C o d e  
 