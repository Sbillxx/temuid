"use client";

import { useEffect, useRef, useState, use } from "react";
import io from "socket.io-client";

let socket: ReturnType<typeof io> | null = null;

interface Peer {
  stream: MediaStream;
}

export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: roomId } = use(params);
  const localVidRef = useRef<HTMLVideoElement>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const pcsRef = useRef<Record<string, RTCPeerConnection>>({});
  const localStreamRef = useRef<MediaStream | null>(null);

  // Auto-detect signaling server URL
  // Pakai environment variable kalau ada (untuk production), kalau tidak pakai auto-detect
  const SIGNALING_SERVER_URL = typeof window !== "undefined" ? process.env.NEXT_PUBLIC_SIGNALING_URL || `${window.location.protocol}//${window.location.hostname}:3001` : process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:3001";

  // Define createPeerConnection before useEffect to avoid "accessed before declared" error
  const createPeerConnection = (peerSocketId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        // tambahin TURN di sini kalau lo punya
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit("ice-candidate", {
          to: peerSocketId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      // event.streams[0] adalah media remote
      setPeers((prev) => ({
        ...prev,
        [peerSocketId]: { stream: event.streams[0] },
      }));
    };

    return pc;
  };

  useEffect(() => {
    socket = io(SIGNALING_SERVER_URL);

    const start = async () => {
      try {
        // Check if mediaDevices is available (requires secure context: HTTPS or localhost)
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          const isSecureContext = window.isSecureContext;
          const protocol = window.location.protocol;
          const hostname = window.location.hostname;

          let errorMsg = "Camera/microphone tidak tersedia.\n\n";

          if (!isSecureContext || (protocol === "http:" && hostname !== "localhost" && hostname !== "127.0.0.1")) {
            errorMsg += "⚠️ Akses via HTTP di IP address tidak dianggap secure oleh browser.\n";
            errorMsg += "Solusi:\n";
            errorMsg += "1. Akses dari laptop pakai: http://localhost:3000/room/" + roomId + "\n";
            errorMsg += "2. Atau setup HTTPS untuk akses via IP\n";
            errorMsg += "3. Atau test pakai multiple tabs di laptop yang sama\n\n";
            errorMsg += `URL saat ini: ${window.location.href}`;
          } else {
            errorMsg += "Browser tidak support getUserMedia atau kamera tidak tersedia.";
          }

          alert(errorMsg);
          console.error("getUserMedia not available:", { isSecureContext, protocol, hostname });
          return;
        }

        // 1. get local media
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        if (localVidRef.current) localVidRef.current.srcObject = stream;

        // 2. connect to signaling & join room
        if (!socket) return;
        socket.emit("join-room", { roomId });

        // 3. when another user joins, create offer
        socket.on("user-joined", async ({ socketId }: { socketId: string }) => {
          if (!socket) return;
          console.log("user-joined", socketId);
          const pc = createPeerConnection(socketId);
          pcsRef.current[socketId] = pc;

          // add local tracks
          stream.getTracks().forEach((t) => pc.addTrack(t, stream));

          // create offer
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("offer", { to: socketId, sdp: offer });
        });

        // 4. when receive offer -> create answer
        socket.on("offer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
          if (!socket) return;
          console.log("got offer from", from);
          const pc = createPeerConnection(from);
          pcsRef.current[from] = pc;

          // add local tracks
          stream.getTracks().forEach((t) => pc.addTrack(t, stream));

          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("answer", { to: from, sdp: answer });
        });

        // 5. when receive answer
        socket.on("answer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
          console.log("got answer from", from);
          const pc = pcsRef.current[from];
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        });

        // 6. ice-candidate
        socket.on("ice-candidate", async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit | null }) => {
          const pc = pcsRef.current[from];
          if (pc && candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
              console.warn("addIceCandidate err:", err);
            }
          }
        });

        // 7. user-left
        socket.on("user-left", ({ socketId }: { socketId: string }) => {
          if (pcsRef.current[socketId]) {
            pcsRef.current[socketId].close();
            delete pcsRef.current[socketId];
            setPeers((p) => {
              const copy = { ...p };
              delete copy[socketId];
              return copy;
            });
          }
        });
      } catch (err) {
        console.error("Error starting media:", err);
      }
    };

    start();

    return () => {
      // cleanup
      if (socket) socket.disconnect();
      // Copy ref values at cleanup time to avoid stale closure
      const currentPcs = pcsRef.current;
      Object.values(currentPcs).forEach((pc) => {
        if (pc && typeof pc.close === "function") {
          pc.close();
        }
      });
      const currentStream = localStreamRef.current;
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [roomId, SIGNALING_SERVER_URL]);

  // Client-side only state untuk URL info (prevent hydration mismatch)
  const [urlInfo, setUrlInfo] = useState<{
    url: string;
    hostname: string;
    isLocalhost: boolean;
    protocol: string;
  } | null>(null);

  useEffect(() => {
    // Set URL info hanya di client-side setelah mount
    // Using setTimeout to avoid synchronous setState in effect
    if (typeof window !== "undefined") {
      const timer = setTimeout(() => {
        const hostname = window.location.hostname;
        setUrlInfo({
          url: window.location.href,
          hostname,
          isLocalhost: hostname === "localhost" || hostname === "127.0.0.1",
          protocol: window.location.protocol,
        });
      }, 0);
      return () => clearTimeout(timer);
    }
  }, []);

  const copyRoomLink = async () => {
    if (!urlInfo) return;

    const currentUrl = urlInfo.url;
    const hostname = urlInfo.hostname;

    // Kalau akses via localhost di laptop, kasih info IP juga
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      // Copy link localhost dulu (untuk laptop)
      await navigator.clipboard.writeText(currentUrl);

      const ipInfo = "⚠️ Link yang di-copy: " + currentUrl + "\n\n";
      const shareInfo =
        ipInfo +
        "Link ini hanya bisa dipakai di device yang sama (laptop ini).\n\n" +
        "Untuk share ke HP:\n" +
        "1. Cari IP laptop Anda (buka CMD → ketik: ipconfig)\n" +
        "2. Buka di HP: http://[IP-LAPTOP]:3000/room/" +
        roomId +
        "\n\n" +
        "⚠️ PERINGATAN: HTTP di IP tidak support kamera!\n" +
        "Solusi pakai HTTPS:\n" +
        "• Install ngrok: npx ngrok@latest http 3000\n" +
        "• Copy URL HTTPS dari ngrok\n" +
        "• Share URL ngrok ke HP";

      alert(shareInfo);
    } else {
      // Kalau sudah akses via IP atau HTTPS, copy link yang sekarang
      await navigator.clipboard.writeText(currentUrl);
      alert(`Room link copied!\n\n${currentUrl}\n\nShare link ini ke teman untuk join room.`);
    }
  };

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" }}>
          <h1 style={{ margin: 0 }}>Meeting Room: {roomId}</h1>
          <button
            onClick={copyRoomLink}
            style={{
              padding: "8px 16px",
              backgroundColor: "#0070f3",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "14px",
            }}
          >
            📋 Copy Room Link
          </button>
          <span style={{ fontSize: "14px", color: "#666" }}>
            👥 Peers: {Object.keys(peers).length + 1} (You + {Object.keys(peers).length})
          </span>
        </div>

        {/* Show URL info - hanya render setelah client-side mount (prevent hydration error) */}
        {urlInfo && (
          <div style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>
            <strong>URL:</strong> {urlInfo.url}
            {urlInfo.isLocalhost && <span style={{ color: "#f59e0b", marginLeft: "8px" }}>⚠️ Akses via localhost - tidak bisa di-share ke HP (pakai IP atau HTTPS)</span>}
            {!urlInfo.isLocalhost && urlInfo.protocol === "http:" && <span style={{ color: "#ef4444", marginLeft: "8px" }}>⚠️ HTTP tidak support kamera di mobile (butuh HTTPS)</span>}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h3>Local</h3>
          <video ref={localVidRef} autoPlay muted playsInline style={{ width: 320, height: 240, backgroundColor: "#000" }} />
        </div>

        <div>
          <h3>Peers ({Object.keys(peers).length})</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "8px",
            }}
          >
            {Object.entries(peers).map(([id, p]) => (
              <div key={id}>
                <p style={{ fontSize: "12px", margin: "4px 0" }}>{id}</p>
                <video
                  ref={(el) => {
                    if (el && p.stream) el.srcObject = p.stream;
                  }}
                  autoPlay
                  playsInline
                  style={{ width: 320, height: 240, backgroundColor: "#000" }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
