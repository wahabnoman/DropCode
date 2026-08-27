<div align="center">

# ⚡ DropCode

### Cyberpunk-grade, zero-install, peer-to-peer file & folder sharing.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P_Direct-333333?style=for-the-badge&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.io-Signaling_%26_Relay-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](https://socket.io/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![Privacy](https://img.shields.io/badge/Privacy-100%25_Self--Hosted-darkgreen?style=for-the-badge)](#-privacy--security)

<p align="center">
  <b>DropCode</b> is a self-hosted, code-paired AirDrop/PairDrop alternative that streams files, folders, and text directly between browsers with <b>no file size limits</b>, <b>no accounts</b>, and <b>instant pairing</b>.
</p>

```
   ___                  ___         _      
  / _ \_______  ___    / __|___  __| |___  
 / // / __/ _ \/ _ \  / /__/ _ \/ _` / -_) 
/____/_/  \___/ .__/  \___/\___/\__,_\___| 
             /_/                           
  // SYS.DROPCODE /// LOCAL-TRANSFER-NODE //
```

</div>

---

## ✨ Key Features

- ⚡ **Direct Peer-to-Peer Streaming** — Transfers stream directly between browsers over WebRTC DataChannels with chunked binary pipelining and backpressure management.
- 🛡️ **Intelligent Relay Fallback** — If WebRTC is blocked by a VPN or strict firewall, DropCode automatically and seamlessly falls back to server-assisted relay.
- 🔑 **Instant 6-Character Pairing** — No accounts, passwords, or emails. The host starts a session, shares the generated code or URL, and peers join in seconds.
- 📁 **Folder & Batch File Transfers** — Drag & drop multiple files or entire folder hierarchies (streamed directly to disk preserving folder trees via the File System Access API).
- 👥 **Multi-Device Star Topology** — Connect small groups under a single session code. Broadcast to everyone or selectively target specific devices using interactive recipient pills.
- ✋ **Explicit Consent** — Incoming transfers display an **Accept / Decline** prompt so nothing downloads without permission.
- 🔄 **Auto-Reconnect & Transfer Resume** — Survives Wi-Fi drops and accidental page refreshes. In-flight transfers resume from their exact byte offset.
- 🔒 **100% Private & Self-Hosted** — Zero tracking, no telemetry, and your data stays on your local network unless explicitly relayed.

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org) (v18 or newer)
- `npm` (comes with Node.js)

### Installation & Launch

```bash
# 1. Clone the repository
git clone https://github.com/wahabnoman/DropCode.git
cd DropCode

# 2. Install dependencies
npm install

# 3. Start the node server
npm start
```

Your terminal will display your active connection endpoints:
```text
--------------------------------------------------
[DROPCODE NODE ONLINE]
  Local Access:    http://localhost:3005
  Network Access:  http://192.168.1.42:3005   <-- Share with devices on your Wi-Fi/LAN
--------------------------------------------------
```

> **Custom Port**: Run on any custom port by setting the `PORT` environment variable:
> ```bash
> PORT=8080 npm start
> ```

---

## 📖 How to Use

```mermaid
flowchart TD
    subgraph LAN / Network
        Host["🖥️ Host (Device A)"]
        Server["⚡ DropCode Server"]
        Peer1["📱 Peer 1 (Device B)"]
        Peer2["💻 Peer 2 (Device C)"]
    end

    Host <-->|1. Create Room & Signaling| Server
    Peer1 <-->|2. Join with 6-char Code| Server
    Peer2 <-->|2. Join with 6-char Code| Server

    Host <-.->|Direct WebRTC P2P DataChannel (Fastest)| Peer1
    Host <-.->|Direct WebRTC P2P DataChannel (Fastest)| Peer2
    Host <===>|Socket.IO Relay (Automatic Fallback)| Server
    Server <===>|Relay Stream| Peer1
```

1. **Host a Session**:
   - Open the web interface and enter your **Device Name**.
   - Click **> Start Sharing** to generate your unique 6-character room code.
2. **Join a Session**:
   - On other devices (phones, laptops, tablets), open the network URL.
   - Enter your name, input the 6-character code, and click **> Connect**.
3. **Send Payloads**:
   - **Targeting**: Toggle device badges to send to all connected devices or only specific peers.
   - **Drop & Send**: Drag files, folders, or type text into the terminal payload area.
   - **Consent**: The recipient accepts the prompt to start streaming.

---

## 🌐 Deploying to the Cloud (Internet Sharing)

While DropCode works out of the box on any local Wi-Fi or LAN network, you can deploy it publicly to transfer files across the internet:

1. **One-Click Cloud Hosting**: Deploy this repository to [Render](https://render.com), [Fly.io](https://fly.io), [Railway](https://railway.app), or any VPS (DigitalOcean, Linode, AWS, Hetzner).
2. **Port Binding**: DropCode automatically respects the platform-assigned `PORT` environment variable (`process.env.PORT`).
3. **NAT & Firewall Traversal**:
   - DropCode includes Google's public STUN servers for standard NAT traversal.
   - For symmetric enterprise firewalls, configure custom TURN credentials in [`public/app.js`](public/app.js) (`ICE_SERVERS`) or use the built-in WebSocket relay fallback.

---

## 🛠️ Architecture & Technologies

| Layer | Technology | Details |
|---|---|---|
| **Server Runtime** | Node.js + Express | Serves the lightweight frontend and powers IP discovery endpoints (`/api/network-info`). |
| **Signaling & Relay** | Socket.IO (WebSockets) | Manages real-time room rosters, WebRTC SDP/ICE exchange, and fallback byte streams. |
| **P2P Transport** | WebRTC DataChannel | Direct browser-to-browser communication with 16KB binary slicing and flow backpressure. |
| **Frontend UI** | Vanilla HTML5 / CSS3 / ES6+ | Retro-futuristic terminal HUD styled with *JetBrains Mono*, zero heavy frameworks or dependencies. |
| **Disk Streaming** | File System Access API | Native browser streaming directly to the filesystem with fallback download modes. |

---

## ⚙️ Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3005` | Port number the HTTP & WebSocket server binds to. |
| `HOST_GRACE_MS` | `20000` *(20s)* | Time a room remains reserved after a host disconnect to allow smooth page refresh/reconnection. |

---

## 🔒 Privacy & Security

- **No Data Retention**: Peer-to-peer file transfers never touch the server disk or memory cache.
- **Zero Third-Party Telemetry**: No tracking scripts, no external analytics, no advertising beacons.
- **Explicit Permission**: Files cannot be pushed to any device without the recipient explicitly clicking **Accept**.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">
  <sub>Developed with ⚡ by <b>Wahab Noman</b></sub>
</div>