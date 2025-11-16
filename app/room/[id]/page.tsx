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
  const [isMuted, setIsMuted] = useState(false);

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
      const remoteStream = event.streams[0];

      // Debug: Log audio tracks dengan track ID untuk tracking
      const audioTracks = remoteStream.getAudioTracks();
      const videoTracks = remoteStream.getVideoTracks();
      console.log(`📥 Received stream from ${peerSocketId}:`, {
        streamId: remoteStream.id,
        audioTracks: audioTracks.length,
        videoTracks: videoTracks.length,
        audioEnabled: audioTracks.map((t) => t.enabled),
        audioTrackIds: audioTracks.map((t) => t.id), // Track ID untuk verify tidak ter-swap
        videoTrackIds: videoTracks.map((t) => t.id),
      });

      // CRITICAL: Jangan replace stream kalau sudah ada (prevent swap)
      setPeers((prev) => {
        // Jika peer sudah ada dan stream ID sama, jangan replace
        if (prev[peerSocketId] && prev[peerSocketId].stream.id === remoteStream.id) {
          console.log(`Stream for ${peerSocketId} already exists with same ID, keeping existing`);
          return prev;
        }

        // Jika peer sudah ada tapi stream ID berbeda, log warning
        if (prev[peerSocketId] && prev[peerSocketId].stream.id !== remoteStream.id) {
          console.warn(`⚠️ Stream ID changed for ${peerSocketId}:`, {
            old: prev[peerSocketId].stream.id,
            new: remoteStream.id,
          });
        }

        return {
          ...prev,
          [peerSocketId]: { stream: remoteStream },
        };
      });
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

        // Debug: Verify local stream has audio
        const localAudioTracks = stream.getAudioTracks();
        const localVideoTracks = stream.getVideoTracks();
        console.log("🎤 Local stream initialized:", {
          audioTracks: localAudioTracks.length,
          videoTracks: localVideoTracks.length,
          audioEnabled: localAudioTracks.map((t) => t.enabled),
          audioSettings: localAudioTracks.map((t) => t.getSettings()),
        });

        if (localAudioTracks.length === 0) {
          console.error("❌ ERROR: No audio tracks in local stream!");
        } else {
          localAudioTracks.forEach((track, idx) => {
            console.log(`  Local audio track ${idx}:`, {
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
            });
            // Ensure audio track is enabled
            track.enabled = true;
          });
        }

        // 2. connect to signaling & join room
        if (!socket) return;
        socket.emit("join-room", { roomId });

        // 3. when another user joins, create offer
        socket.on("user-joined", async ({ socketId }: { socketId: string }) => {
          if (!socket) return;
          console.log("user-joined", socketId);
          const pc = createPeerConnection(socketId);
          pcsRef.current[socketId] = pc;

          // add local tracks - VERIFY audio tracks are included
          const tracksToAdd = stream.getTracks();
          const audioTracksToAdd = tracksToAdd.filter((t) => t.kind === "audio");
          const videoTracksToAdd = tracksToAdd.filter((t) => t.kind === "video");

          console.log(`Adding tracks to peer ${socketId}:`, {
            total: tracksToAdd.length,
            audio: audioTracksToAdd.length,
            video: videoTracksToAdd.length,
            audioEnabled: audioTracksToAdd.map((t) => t.enabled),
          });

          // Check if tracks already added to prevent duplicate
          const existingSenders = pc.getSenders();
          const existingAudioTrackIds = existingSenders.filter((s) => s.track?.kind === "audio").map((s) => s.track?.id);

          tracksToAdd.forEach((t) => {
            // Skip if track already added (prevent duplicate)
            if (t.kind === "audio" && existingAudioTrackIds.includes(t.id)) {
              console.log(`  Audio track ${t.id} already added to ${socketId}, skipping`);
              return;
            }

            // Ensure track is enabled before adding
            if (t.kind === "audio") {
              t.enabled = true;
              console.log(`  ➕ Adding audio track ${t.id} (enabled: ${t.enabled}) to ${socketId}`);
            }
            pc.addTrack(t, stream);
          });

          // Verify tracks were added dengan track ID
          const senders = pc.getSenders();
          const audioSenders = senders.filter((s) => s.track?.kind === "audio");
          console.log(`✅ Tracks added to peer ${socketId} - Senders:`, {
            total: senders.length,
            audioSenders: audioSenders.length,
            audioTrackIds: audioSenders.map((s) => s.track?.id), // Track ID untuk verify
            localAudioTrackId: audioTracksToAdd[0]?.id, // Track ID yang kita kirim
          });

          // create offer
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("offer", { to: socketId, sdp: offer });
        });

        // 4. when receive offer -> create answer
        socket.on("offer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
          if (!socket) return;
          console.log("got offer from", from);

          // Check if peer connection already exists
          if (pcsRef.current[from]) {
            console.warn("Peer connection already exists for:", from, "closing old one");
            pcsRef.current[from].close();
          }

          const pc = createPeerConnection(from);
          pcsRef.current[from] = pc;

          // add local tracks - VERIFY audio tracks are included
          const tracksToAdd = stream.getTracks();
          const audioTracksToAdd = tracksToAdd.filter((t) => t.kind === "audio");

          console.log(`Adding tracks (answer) to peer ${from}:`, {
            total: tracksToAdd.length,
            audio: audioTracksToAdd.length,
            audioEnabled: audioTracksToAdd.map((t) => t.enabled),
          });

          // Check if tracks already added to prevent duplicate
          const existingSenders = pc.getSenders();
          const existingAudioTrackIds = existingSenders.filter((s) => s.track?.kind === "audio").map((s) => s.track?.id);

          tracksToAdd.forEach((t) => {
            // Skip if track already added (prevent duplicate)
            if (t.kind === "audio" && existingAudioTrackIds.includes(t.id)) {
              console.log(`  Audio track ${t.id} already added to ${from}, skipping`);
              return;
            }

            // Ensure track is enabled before adding
            if (t.kind === "audio") {
              t.enabled = true;
              console.log(`  ➕ Adding audio track ${t.id} (enabled: ${t.enabled}) to ${from}`);
            }
            pc.addTrack(t, stream);
          });

          // Verify tracks were added dengan track ID
          const senders = pc.getSenders();
          const audioSenders = senders.filter((s) => s.track?.kind === "audio");
          console.log(`✅ Tracks added (answer) to peer ${from} - Senders:`, {
            total: senders.length,
            audioSenders: audioSenders.length,
            audioTrackIds: audioSenders.map((s) => s.track?.id), // Track ID untuk verify
            localAudioTrackId: audioTracksToAdd[0]?.id, // Track ID yang kita kirim
          });

          try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            console.log("Remote offer set, creating answer...");
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log("Answer created, sending to:", from);
            socket.emit("answer", { to: from, sdp: answer });
          } catch (err) {
            console.error("Error handling offer:", err);
            // Clean up on error
            pc.close();
            delete pcsRef.current[from];
          }
        });

        // 5. when receive answer
        socket.on("answer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
          console.log("got answer from", from, "current signaling state:", pcsRef.current[from]?.signalingState);
          const pc = pcsRef.current[from];
          if (!pc) {
            console.warn("No peer connection found for answer from:", from);
            return;
          }

          // Check signaling state - must be "have-local-offer" to accept answer
          // If already stable, means negotiation already completed (duplicate answer)
          if (pc.signalingState === "stable") {
            console.log("Connection already stable, negotiation completed. Ignoring duplicate answer.");
            return;
          }

          if (pc.signalingState === "closed") {
            console.warn("Connection is closed, cannot set remote description");
            return;
          }

          // Store state before narrow check
          const initialState = pc.signalingState;

          // Only accept answer if we're in "have-local-offer" state
          if (initialState !== "have-local-offer") {
            console.warn(`Invalid signaling state for answer: ${initialState}. Expected: have-local-offer. Ignoring.`);
            return;
          }

          try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            console.log("Remote description (answer) set successfully, new state:", pc.signalingState);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);

            // If error is about wrong state, it's likely a race condition - log but don't crash
            if (errorMessage.includes("stable") || errorMessage.includes("wrong state")) {
              console.warn("Answer arrived too late (connection already stable). This is OK, ignoring:", errorMessage);
              return;
            }

            console.error("Error setting remote description:", err);

            // Check current state before cleanup (may have changed after async operation)
            const currentState = pc.signalingState as string;
            // Only clean up if not already in terminal states
            if (currentState !== "stable" && currentState !== "closed") {
              try {
                pc.close();
              } catch (closeErr) {
                console.warn("Error closing connection:", closeErr);
              }
              delete pcsRef.current[from];
              setPeers((p) => {
                const copy = { ...p };
                delete copy[from];
                return copy;
              });
            }
          }
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

  const toggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const audioTracks = stream.getAudioTracks();
    const newMutedState = !isMuted;

    // Enable/disable all audio tracks
    // Karena track di-share ke semua peer connections, cukup update enabled state
    audioTracks.forEach((track) => {
      track.enabled = !newMutedState;
    });

    setIsMuted(newMutedState);
    console.log(`Microphone ${newMutedState ? "muted" : "unmuted"}`);
  };

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
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
            <h3 style={{ margin: 0 }}>Local</h3>
            <button
              onClick={toggleMute}
              style={{
                padding: "6px 12px",
                backgroundColor: isMuted ? "#ef4444" : "#10b981",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
              title={isMuted ? "Unmute microphone" : "Mute microphone"}
            >
              {isMuted ? "🔇 Muted" : "🎤 Unmuted"}
            </button>
          </div>
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
            {Object.entries(peers).map(([id, p]) => {
              const audioTracks = p.stream?.getAudioTracks() || [];
              const hasAudio = audioTracks.length > 0;
              const audioEnabled = audioTracks.every((t) => t.enabled);

              return (
                <div key={id}>
                  <div style={{ display: "flex", gap: "4px", alignItems: "center", marginBottom: "4px" }}>
                    <p style={{ fontSize: "12px", margin: 0 }}>{id}</p>
                    {hasAudio && <span style={{ fontSize: "10px", color: audioEnabled ? "#10b981" : "#ef4444" }}>{audioEnabled ? "🎤" : "🔇"}</span>}
                  </div>
                  <video
                    ref={(el) => {
                      if (el && p.stream) {
                        el.srcObject = p.stream;
                        // Unmute peer video untuk bisa dengar suara
                        el.muted = false;
                        el.volume = 1.0;

                        // Debug: Log audio tracks
                        const audioTracks = p.stream.getAudioTracks();
                        console.log(`Peer ${id} audio tracks:`, audioTracks.length, {
                          enabled: audioTracks.map((t) => t.enabled),
                          muted: audioTracks.map((t) => t.muted),
                        });

                        // Force play (might need user interaction first)
                        el.play().catch((err) => {
                          console.warn(`Cannot play peer video ${id}:`, err);
                        });
                      }
                    }}
                    autoPlay
                    playsInline
                    muted={false}
                    style={{ width: 320, height: 240, backgroundColor: "#000" }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
