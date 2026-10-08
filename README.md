# DropCode

Your own AirDrop/PairDrop-style sharing tool: no size limits, no account,
files go directly between browsers over WebRTC whenever possible. If a
direct connection can't be made (a VPN or firewall commonly blocks WebRTC
outright), it automatically carries on through this server instead — the
same tradeoff PairDrop's `WS_FALLBACK` makes, and for the same reason — and
goes back to a direct link whenever one opens. No setting to flip. See
"Direct first, server relay underneath" below.

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
4. Once it shows "Connected", pick who you're sending to (see below), then
   drag & drop files or a whole folder, or type text. Drop several files or
   a big folder at once and they all start right away instead of waiting in
   line. Whoever a file is aimed at gets an incoming-transfer prompt and
   nothing moves until they accept.

The link is "fixed" in the sense that it's always the same address as long
as your laptop's IP doesn't change — you generate a fresh pairing code each
time you click "Start Sharing", so old codes can't be reused after you stop
sharing.

### Choosing who to send to

Every other device in the session appears as a card in the **Send to**
section — an avatar, its name, and how you're connected to it (Direct or
Relayed; for a friend's device that isn't the host it says "via host").
Tap a card to tick or untick it; **Select all / Select none** flips the lot.
A line underneath always says exactly where your next send will go
("Sending to everyone (3 devices)", "Sending to 1 of 3 devices").

Nothing is sent to a device you've unticked. If nothing is ticked — or nobody
else has joined yet — the file picker, drop zone and text box lock and say
why, rather than quietly sending somewhere you didn't intend.

### Connecting more than one friend

The same code works for as many devices as you want to invite — just keep
sharing the same code and link with everyone. Everyone who joins shows up
as a card on every other device's screen (host and friends alike), labeled
with whatever device name they picked. By default a send goes to everyone in
the session, so it works as a shared drop for a small group, not just a 1:1
pairing — untick cards to reach only some of them. If your laptop (the
host) closes the page or disconnects, the whole session ends for everyone;
if one friend leaves, everyone else stays connected.

### Naming your device

Type a name in **Your device name** before you start/join — it's what
everyone else sees in their device list. It's remembered on that browser
for next time. You can also change it mid-session under **You are:** in the
session screen; the new name shows up for everyone immediately.

### Accepting or declining a transfer

Nobody receives a file or folder without a chance to say no first. When
something is sent to you, a dialog opens: who it's from, how many files and
how big, the file names, and a plain note on where it will be saved. **Accept**
or **Decline** — nothing streams until you accept. A folder or multi-file
drop arrives as **one** prompt ("Alex wants to send you 120 files · 3.4 GB"),
not one per file. Text messages arrive straight away without a prompt.

Press Esc or click outside the dialog to decide later: the offers stay in
your Transfers list with their own Accept / Decline buttons (and an
**Accept all / Decline all** bar), and while the tab is in the background its
title shows "(1) Incoming" so you can spot it.

Each transfer row shows who it's going to or from, a live percentage and
speed, and — for a send to several devices — each device's state
("Pixel: 45% · iMac: waiting for them to accept"). **Clear finished** tidies
the list.

### No limits

DropCode puts no cap on what you send or receive: no file-size limit, no
limit on the number of files in a folder, and no limit on text (long text is
split into parts and reassembled on the other side). The only practical
ceilings are your disk space and, for receiving, what your browser can do:

- Where the browser can write straight to disk (Chrome/Edge on `https://` or
  `localhost`), a received file of any size goes directly to disk as it
  arrives, so memory use stays flat.
- On a plain `http://` LAN address browsers hide that capability. DropCode
  then collects the file in browser-managed storage and downloads it at the
  end — fine for large files on desktop browsers, which page it out to disk,
  but you'll want free disk space and the tab left open (the dialog says so
  for anything over 1 GB). To get streaming-to-disk on a LAN, serve the app
  over HTTPS or open it via `localhost` on the receiving machine.

### Sending several things at once

Drop 5 files, or a folder with hundreds of files in it, and every offer
goes out immediately instead of waiting for the previous one to finish —
accept them in any order, and up to a few move at once (more than that
just queues briefly rather than fighting each other for bandwidth). This
also means a folder full of files doesn't stall behind one big file dropped
alongside it.

## Direct first, server relay underneath (automatic)

There's nothing to configure. Every connection first tries a direct
peer-to-peer WebRTC link. If that hasn't opened within about 2.5 seconds
(or fails outright — a VPN client or firewall policy blocking the WebRTC
handshake is the usual cause, and exactly what PairDrop's `WS_FALLBACK`
exists to work around), the connection carries on through your own
DropCode server, so it is usable immediately instead of stuck "connecting".
If a direct link opens later, new traffic switches over to it by itself;
and if a direct link drops mid-transfer, the transfer continues over the
relay and DropCode quietly tries to re-establish the direct link in the
background.

You can always tell which path is active: the connection status says
"(relayed via server)" and the device's chip on the host's screen says
"· relayed" — DropCode never silently pretends a relayed connection is
peer-to-peer.

**Tradeoff:** relayed data passes through your own DropCode server (still
just your laptop, not a third party) instead of going directly between the
two browsers. The server only passes it along — it stores nothing.

To reproduce a network that blocks WebRTC, open the page with `?direct=0`
(it skips the direct attempt entirely and uses the relay).

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
where it left off**, not from scratch. The *receiver* is the source of
truth: it knows exactly how many bytes it has, so when data stops arriving
(or a connection comes back) it asks the sender to continue from that byte.
Every data frame carries its own byte offset, so a duplicated or skipped
frame can never be written in the wrong place — the receiver ignores
anything that doesn't line up and asks again. This works for any
connection, including a file relayed through the host between two other
devices.

**A file only shows as "done" once the recipient actually confirms it
finished writing it** — handing the last byte to the network is not the
same thing as the other side having it, so the sender waits for that
confirmation rather than assuming delivery. If a device drops at the exact
moment the confirmation was on its way (rather than mid-file), the sender
notices within a few seconds and automatically checks back in, resending
just the confirmation (never the whole file again) once it's answered.

This is about the *connection* recovering — closing the tab entirely (not
just reloading it) still ends anything in flight; there's no resume across
that.

## Notes on large files and folders

- If the receiving browser supports the File System Access API (current
  Chrome/Edge, on `https://` or `localhost`), a folder drop asks you once to
  pick a destination folder, and any single file of 64 MB or more asks where
  to save it — those stream straight to disk as they arrive, with no memory
  limit. Smaller single files just download normally, without a dialog.
- Everywhere else (Firefox, Safari, or a plain `http://` LAN address, where
  browsers hide that API) a file is collected in memory and then downloaded.
  It's folded into browser-managed Blobs as it arrives, which lets the
  browser page it out to disk, so multi-GB files generally still work — but
  a very large file can use a lot of memory on those setups. Folder drops
  download individually into your normal Downloads folder, with the folder
  path baked into the filename (e.g. `Photos__2024__trip.jpg`) so nothing is
  lost.
- When several files are offered at once, an **Accept all / Decline all**
  bar appears above the transfer list; folder drops only ask for the
  destination folder once.
- Closing the tab mid-transfer is the most common way to lose one, so the
  browser asks for confirmation if you try while something is in flight.

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
   network (e.g. corporate Wi-Fi), add a TURN server — a free tier from
   [Metered](https://www.metered.ca/tools/openrelay/) or
   [Twilio](https://www.twilio.com/docs/stun-turn) works — via environment
   variables, no code changes needed:
   ```bash
   TURN_URLS=turn:example.com:3478 TURN_USERNAME=user TURN_CREDENTIAL=pass npm start
   ```
   `TURN_URLS` accepts a comma-separated list if your provider gives you
   more than one. Not needed for same-network or typical home internet use.

### Running with Docker

```bash
docker build -t dropcode .
docker run -p 3005:3005 -e TURN_URLS=... -e TURN_USERNAME=... -e TURN_CREDENTIAL=... dropcode
```

## How it works (short version)

- `server.js` — Express + Socket.IO. Generates pairing codes and relays
  WebRTC offer/answer/ICE messages between the host and each joining
  device. It also relays actual file/text data, but only for a connection
  that has fallen back to relay mode (see above) — a normal peer-to-peer
  connection's data never passes through it.
- `public/app.js` — Every device connects directly to the host over its own
  `RTCPeerConnection` ("star" topology — friends don't connect to each
  other directly, only to the host), with the Socket.IO relay as a
  fallback path underneath (see above). Each connection carries one ordered
  channel used for both small JSON control messages (file offers,
  accept/decline, acks, text) and binary file frames. Every send names its
  intended recipient device id(s); when the host receives something meant
  for someone other than itself, it forwards it on to exactly those
  devices instead of blindly broadcasting, so a group of 3+ people can
  share with each other — or with just one specific person — through one
  code. A file/folder transfer always starts with an offer that the
  recipient(s) must accept before any bytes move.
- **Transfer protocol** (modelled on PairDrop's, extended): files go out in
  64 KB frames, and the receiver acks how much it has safely written every
  ~512 KB; the sender never has more than 4 MB un-acked in flight. That
  window applies on both the direct and the relayed path, so a huge file
  can't pile up in memory on the sender, the server, or the receiver — and
  the sender's progress bar shows what the receiver confirmed, not what was
  merely queued. A file counts as complete only at the exact byte count.
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
- Every frame is `[slot][byte offset][payload]`. The slot lets several
  files stream over one connection at once (and tells a relaying host where
  to forward it); the offset makes recovery exact — a duplicated or skipped
  frame is detected and never written in the wrong place. Each stream stays
  on the path it started on, so switching between direct and relay can't
  reorder it.
- Recovery is receiver-driven: the receiver knows exactly how many bytes it
  has, so when data stops (or a connection comes back) it sends the sender a
  "continue from byte N" request. The sender keeps no resume state beyond
  holding the file.
- A transfer is only marked done on the sender's side once the recipient
  sends back an explicit "I actually finished writing this" confirmation —
  queuing the last byte into a data channel or a relay socket only means it
  was attempted, not delivered. If that confirmation is lost the sender
  keeps asking "did you get it all?" until it's answered; a lost accept,
  decline or offer is likewise re-sent rather than left waiting forever.
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
  retrying. Clicking Disconnect stops it. (The direct-link retry is
  bounded — after a few failed attempts a connection simply stays on the
  relay.)
- With several devices connected, the host's browser does the work of
  relaying anything it receives out to everyone else — that's normal
  browser-tab memory/CPU, but very large fan-out to many devices at once
  will be somewhat limited by the host device's own performance. A file
  sent from one non-host device to several others is streamed once per
  recipient, not once in total.
- Offers and accepts are still per file (a folder is many files), though
  "Accept all" answers them in one click. An offer to a device that has left
  the room is dropped after about 20 seconds; one to a device that's merely
  slow to answer just waits for it.
- It's a live transfer, not store-and-forward: both devices have to be
  online together (unlike a service such as AirForShare, which uploads to a
  server and lets the other side download later).
- Folder drops download as separate files where the browser can't write
  into a chosen folder (no zip bundling).

---

**// Designed by Wahab //**
