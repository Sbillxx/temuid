"use client";

import { useEffect, useRef, useState, use } from "react";
import io from "socket.io-client";

let socket: ReturnType<typeof io> | null = null;

interface Peer {
  stream: MediaStream;
  videoRef?: HTMLVideoElement | null;
  canvasRef?: HTMLCanvasElement | null;
  isCameraOff?: boolean;
}

export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: roomId } = use(params);
  const localVidRef = useRef<HTMLVideoElement>(null);
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const pcsRef = useRef<Record<string, RTCPeerConnection>>({});
  const localStreamRef = useRef<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user"); // "user" = front, "environment" = back
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  // Store video refs separately to avoid infinite loop
  const peerVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

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
      const remoteAudioTracks = remoteStream.getAudioTracks();
      const remoteVideoTracks = remoteStream.getVideoTracks();
      console.log(`📥 Received stream from ${peerSocketId}:`, {
        streamId: remoteStream.id,
        audioTracks: remoteAudioTracks.length,
        videoTracks: remoteVideoTracks.length,
        audioEnabled: remoteAudioTracks.map((t) => t.enabled),
        audioTrackIds: remoteAudioTracks.map((t) => t.id), // Track ID untuk verify tidak ter-swap
        videoTrackIds: remoteVideoTracks.map((t) => t.id),
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

        // Initialize isCameraOff berdasarkan track state saat ini
        const videoTracks = remoteStream.getVideoTracks();
        const initialCameraOff = videoTracks.length === 0 || videoTracks.every((track) => !track.enabled);

        return {
          ...prev,
          [peerSocketId]: {
            stream: remoteStream,
            isCameraOff: initialCameraOff,
          },
        };
      });

      // Monitor video track state changes untuk detect camera on/off
      const remoteVideoTracksForMonitor = remoteStream.getVideoTracks();
      remoteVideoTracksForMonitor.forEach((track) => {
        // Check initial state
        if (!track.enabled) {
          setPeers((prev) => {
            if (prev[peerSocketId]) {
              return {
                ...prev,
                [peerSocketId]: { ...prev[peerSocketId], isCameraOff: true },
              };
            }
            return prev;
          });
        }

        // Listen for track ended event
        track.onended = () => {
          console.log(`Video track ended for ${peerSocketId}`);
          setPeers((prev) => {
            if (prev[peerSocketId]) {
              return {
                ...prev,
                [peerSocketId]: { ...prev[peerSocketId], isCameraOff: true },
              };
            }
            return prev;
          });
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

        // 1. Get available cameras
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cameras = devices.filter((device) => device.kind === "videoinput");
          setAvailableCameras(cameras);
          console.log(
            `📷 Found ${cameras.length} cameras:`,
            cameras.map((c) => ({ label: c.label, deviceId: c.deviceId }))
          );
        } catch (err) {
          console.warn("Failed to enumerate cameras:", err);
        }

        // 2. get local media dengan facingMode (use current facingMode state)
        const currentFacingMode = facingMode; // Capture current value
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: currentFacingMode, // "user" = front, "environment" = back
          },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, SIGNALING_SERVER_URL]); // facingMode tidak perlu di dependency karena flipCamera handle sendiri

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

  // Tidak perlu monitor peer camera state - biarkan hitam saja kalau off

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

  const captureFrameToCanvas = () => {
    const video = localVidRef.current;
    const canvas = localCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return; // Video belum ready

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size sama dengan video
    const width = video.videoWidth || 320;
    const height = video.videoHeight || 240;
    canvas.width = width;
    canvas.height = height;

    // Draw video frame ke canvas dengan blur effect
    ctx.save();
    ctx.scale(-1, 1); // Mirror horizontal
    ctx.filter = "blur(15px)"; // Apply blur
    ctx.drawImage(video, -width, 0, width, height);
    ctx.restore();
  };

  const toggleCamera = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const videoTracks = stream.getVideoTracks();
    const newCameraOffState = !isCameraOff;

    if (newCameraOffState) {
      // Capture frame terakhir sebelum off
      captureFrameToCanvas();
    }

    // Enable/disable all video tracks
    videoTracks.forEach((track) => {
      track.enabled = !newCameraOffState;
    });

    setIsCameraOff(newCameraOffState);
    console.log(`Camera ${newCameraOffState ? "off" : "on"}`);
  };

  const flipCamera = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    // Check if camera is off - don't flip if off
    if (isCameraOff) {
      alert("Please turn on camera first before flipping!");
      return;
    }

    // Check if multiple cameras available
    const hasMultipleCameras = availableCameras.length > 1;
    if (!hasMultipleCameras) {
      alert("Only one camera available. Cannot flip.");
      return;
    }

    try {
      // Get old video track first
      const oldVideoTrack = stream.getVideoTracks()[0];
      if (!oldVideoTrack) {
        console.error("No video track found");
        return;
      }

      // Get new facing mode (flip between front and back)
      const newFacingMode = facingMode === "user" ? "environment" : "user";

      // Stop old track FIRST before requesting new one (prevent "Could not start video source" error)
      oldVideoTrack.stop();

      // Small delay to ensure old track is fully released
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get new video stream with new facing mode
      let newStream: MediaStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: newFacingMode,
          },
          audio: false, // Keep existing audio track
        });
      } catch (facingModeError) {
        // If facingMode fails, try using deviceId instead
        console.warn("facingMode failed, trying deviceId:", facingModeError);

        // Find camera with different facing mode
        const currentDeviceId = oldVideoTrack.getSettings().deviceId;
        const otherCamera = availableCameras.find((cam) => cam.deviceId !== currentDeviceId);

        if (otherCamera) {
          newStream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: otherCamera.deviceId },
            },
            audio: false,
          });
        } else {
          throw facingModeError;
        }
      }

      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) {
        console.error("Failed to get new video track");
        newStream.getTracks().forEach((t) => t.stop()); // Cleanup
        return;
      }

      // Remove old track from stream (already stopped)
      stream.removeTrack(oldVideoTrack);

      // Add new track to stream
      stream.addTrack(newVideoTrack);

      // Update local video element
      if (localVidRef.current) {
        localVidRef.current.srcObject = stream;
      }

      // Replace video track in all peer connections
      await Promise.all(
        Object.entries(pcsRef.current).map(async ([peerId, pc]) => {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
          if (sender) {
            try {
              await sender.replaceTrack(newVideoTrack);
            } catch (err) {
              console.error(`Failed to replace track for peer ${peerId}:`, err);
            }
          }
        })
      );

      setFacingMode(newFacingMode);
      console.log(`📷 Camera flipped to ${newFacingMode === "user" ? "front" : "back"}`);

      // Cleanup newStream (tracks sudah di-add ke stream utama)
      newStream.getTracks().forEach((t) => {
        if (t !== newVideoTrack) t.stop(); // Stop any extra tracks
      });
    } catch (err) {
      console.error("Failed to flip camera:", err);
      alert(`Failed to flip camera: ${err instanceof Error ? err.message : "Unknown error"}\n\nPlease try again or refresh the page.`);

      // Try to restore old track if possible
      try {
        const stream = localStreamRef.current;
        if (stream) {
          const videoTracks = stream.getVideoTracks();
          if (videoTracks.length === 0) {
            // No video track, need to reinitialize
            console.warn("No video track after flip failure, may need to refresh");
          }
        }
      } catch (restoreErr) {
        console.error("Failed to restore camera:", restoreErr);
      }
    }
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
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" }}>
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
            <button
              onClick={toggleCamera}
              style={{
                padding: "6px 12px",
                backgroundColor: isCameraOff ? "#ef4444" : "#10b981",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
              title={isCameraOff ? "Turn camera on" : "Turn camera off"}
            >
              {isCameraOff ? "📷 Camera Off" : "📹 Camera On"}
            </button>
            {availableCameras.length > 1 && !isCameraOff && (
              <button
                onClick={flipCamera}
                style={{
                  padding: "6px 12px",
                  backgroundColor: "#0070f3",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
                title={`Flip to ${facingMode === "user" ? "back" : "front"} camera`}
              >
                🔄 {facingMode === "user" ? "Back" : "Front"}
              </button>
            )}
          </div>
          <div style={{ position: "relative", width: 320, height: 240 }}>
            <video
              ref={localVidRef}
              autoPlay
              muted
              playsInline
              style={{
                width: 320,
                height: 240,
                backgroundColor: "#000",
                transform: "scaleX(-1)", // Mirror video (seperti cermin)
                display: isCameraOff ? "none" : "block",
              }}
            />
            <canvas
              ref={localCanvasRef}
              style={{
                width: 320,
                height: 240,
                backgroundColor: "#000",
                position: "absolute",
                top: 0,
                left: 0,
                display: isCameraOff ? "block" : "none",
              }}
            />
          </div>
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
              // Peer camera off - biarkan hitam saja (tidak perlu deteksi state)
              const isPeerCameraOff = false; // Always show video, biarkan hitam kalau track disabled

              return (
                <div key={id}>
                  <div style={{ display: "flex", gap: "4px", alignItems: "center", marginBottom: "4px" }}>
                    <p style={{ fontSize: "12px", margin: 0 }}>{id}</p>
                    {hasAudio && <span style={{ fontSize: "10px", color: audioEnabled ? "#10b981" : "#ef4444" }}>{audioEnabled ? "🎤" : "🔇"}</span>}
                  </div>
                  <div style={{ position: "relative", width: 320, height: 240 }}>
                    <video
                      ref={(el) => {
                        if (el && p.stream) {
                          // Store ref tanpa setState (prevent infinite loop)
                          peerVideoRefs.current[id] = el;

                          // Set srcObject hanya jika belum di-set atau berbeda
                          if (el.srcObject !== p.stream) {
                            el.srcObject = p.stream;
                          }

                          // Unmute peer video untuk bisa dengar suara
                          el.muted = false;
                          el.volume = 1.0;

                          // Debug: Log audio tracks (hanya sekali)
                          if (!el.dataset.logged) {
                            const audioTracks = p.stream.getAudioTracks();
                            console.log(`Peer ${id} audio tracks:`, audioTracks.length, {
                              enabled: audioTracks.map((t) => t.enabled),
                              muted: audioTracks.map((t) => t.muted),
                            });
                            el.dataset.logged = "true";
                          }

                          // Force play hanya jika belum playing (prevent interrupt error)
                          if (el.paused && el.readyState >= 2) {
                            el.play().catch((err) => {
                              // Ignore AbortError (play request interrupted)
                              if (err.name !== "AbortError") {
                                console.warn(`Cannot play peer video ${id}:`, err);
                              }
                            });
                          }
                        } else if (!el) {
                          // Cleanup
                          delete peerVideoRefs.current[id];
                        }
                      }}
                      autoPlay
                      playsInline
                      muted={false}
                      style={{
                        width: 320,
                        height: 240,
                        backgroundColor: "#000",
                        transform: "scaleX(-1)", // Mirror video (seperti cermin)
                        display: isPeerCameraOff ? "none" : "block",
                      }}
                    />
                    {/* Peer camera off - biarkan hitam saja (tidak perlu placeholder) */}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
