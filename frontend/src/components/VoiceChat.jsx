import { useEffect, useRef, useState, useCallback } from "react";
import socket from "../socket";

export default function VoiceChat({ roomId, username }) {
    const [isJoined, setIsJoined] = useState(false);
    const [isMuted, setIsMuted] = useState(true);
    const [peers, setPeers] = useState({}); // { socketId: { username, isMuted, status } }
    
    const localStreamRef = useRef(null);
    const peersRef = useRef({}); // { socketId: RTCPeerConnection }
    const iceQueuesRef = useRef({}); // { socketId: [candidates] }

    const createPeerConnection = useCallback((targetSocketId, isInitiator, targetUsername) => {
        console.log(`Creating PeerConnection for ${targetUsername} (${targetSocketId}), isInitiator: ${isInitiator}`);
        
        // Comprehensive ICE servers for both internal and external NAT traversal
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
                { urls: "stun:stun2.l.google.com:19302" },
                { urls: "stun:stun3.l.google.com:19302" },
                { urls: "stun:stun4.l.google.com:19302" },
                { urls: "stun:stun.services.mozilla.com" },
                { urls: "stun:stun.stunprotocol.org:3478" },
                {
                    urls: "turn:openrelay.metered.ca:80",
                    username: "openrelayproject",
                    credential: "openrelayproject"
                },
                {
                    urls: "turn:openrelay.metered.ca:443",
                    username: "openrelayproject",
                    credential: "openrelayproject"
                }
            ],
            iceCandidatePoolSize: 10,
        });

        peersRef.current[targetSocketId] = pc;
        iceQueuesRef.current[targetSocketId] = [];

        setPeers(prev => ({ 
            ...prev, 
            [targetSocketId]: { 
                username: targetUsername || "Peer", 
                isMuted: true, 
                status: "init" 
            } 
        }));

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            console.log(`ICE Connection State with ${targetSocketId}: ${state}`);
            setPeers(prev => prev[targetSocketId] ? {
                ...prev,
                [targetSocketId]: { ...prev[targetSocketId], status: state }
            } : prev);
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // console.log(`Sending ICE candidate to ${targetSocketId}`);
                socket.emit("voice_signal", {
                    to: targetSocketId,
                    signal: { type: "candidate", candidate: event.candidate },
                });
            }
        };

        pc.ontrack = (event) => {
            console.log(`Received remote track from ${targetSocketId}`);
            const stream = event.streams[0];
            const audio = document.getElementById(`audio-${targetSocketId}`) || document.createElement("audio");
            audio.id = `audio-${targetSocketId}`;
            audio.srcObject = stream;
            audio.setAttribute("autoplay", "autoplay");
            audio.setAttribute("playsinline", "playsinline");
            audio.muted = false;
            if (!document.getElementById(`audio-${targetSocketId}`)) {
                document.body.appendChild(audio);
            }
            audio.play().catch(err => {
                console.warn("Autoplay blocked - user interaction required", err);
                // The "Fix Sound" button will handle this
            });
        };

        // Important: Add local tracks BEFORE creating offer
        if (localStreamRef.current) {
            console.log("Adding local tracks to PC");
            localStreamRef.current.getTracks().forEach((track) => {
                pc.addTrack(track, localStreamRef.current);
            });
        }

        if (isInitiator) {
            console.log("Creating offer...");
            pc.createOffer({ offerToReceiveAudio: true })
                .then((offer) => {
                    console.log("Offer created, setting local description");
                    return pc.setLocalDescription(offer);
                })
                .then(() => {
                    socket.emit("voice_signal", {
                        to: targetSocketId,
                        signal: { type: "offer", sdp: pc.localDescription },
                    });
                })
                .catch(err => console.error("Error creating offer", err));
        }

        // Helper to process queued candidates
        pc.processIceQueue = () => {
            const queue = iceQueuesRef.current[targetSocketId];
            if (pc.remoteDescription && queue) {
                while (queue.length > 0) {
                    const cand = queue.shift();
                    pc.addIceCandidate(new RTCIceCandidate(cand))
                      .catch(e => console.error("Error adding queued candidate", e));
                }
            }
        };

        pc.queueCandidate = (cand) => {
            if (pc.remoteDescription && pc.remoteDescription.type) {
                pc.addIceCandidate(new RTCIceCandidate(cand))
                  .catch(e => console.error("Error adding candidate", e));
            } else {
                if (!iceQueuesRef.current[targetSocketId]) iceQueuesRef.current[targetSocketId] = [];
                iceQueuesRef.current[targetSocketId].push(cand);
            }
        };

        return pc;
    }, []);

    const joinVoice = async () => {
        if (!window.isSecureContext) {
            alert("Secure context required (HTTPS).");
            return;
        }

        // Audio Primer for Safari
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const audioCtx = new AudioContext();
            audioCtx.resume();
        } catch (e) {}

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localStreamRef.current = stream;
            stream.getAudioTracks()[0].enabled = false;
            setIsJoined(true);
            setIsMuted(true);
            socket.emit("voice_join", { roomId, username });
        } catch (err) {
            alert("Mic access failed. Check HTTPS/permissions.");
        }
    };

    const toggleMute = () => {
        if (localStreamRef.current) {
            const nextMuted = !isMuted;
            localStreamRef.current.getAudioTracks()[0].enabled = !nextMuted;
            setIsMuted(nextMuted);
            socket.emit("voice_toggle_mic", { isMuted: nextMuted });
        }
    };

    const fixSound = () => {
        document.querySelectorAll('audio[id^="audio-"]').forEach(audio => {
            audio.play().catch(e => console.error("Fix failed", e));
        });
        // Also resume AudioContext if any
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioContext();
            ctx.resume();
        } catch (e) {}
    };

    useEffect(() => {
        if (!isJoined) return;

        socket.on("voice_room_users", ({ users }) => {
            users.forEach(u => {
                if (u.socketId !== socket.id) {
                    createPeerConnection(u.socketId, true, u.username);
                }
            });
        });

        socket.on("user_joined_voice", ({ socketId, username: peerName }) => {
            if (socketId === socket.id) return;
            createPeerConnection(socketId, true, peerName);
        });

        socket.on("voice_signal", async ({ from, fromUsername, signal }) => {
            let pc = peersRef.current[from];
            if (!pc) {
                pc = createPeerConnection(from, false, fromUsername);
            }

            if (signal.type === "offer") {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    pc.processIceQueue();
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    socket.emit("voice_signal", { to: from, signal: { type: "answer", sdp: pc.localDescription } });
                } catch (e) {
                    console.error("Error in offer:", e);
                }
            } else if (signal.type === "answer") {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    pc.processIceQueue();
                } catch (e) {
                    console.error("Error in answer:", e);
                }
            } else if (signal.type === "candidate") {
                pc.queueCandidate(signal.candidate);
            }
        });

        socket.on("voice_toggle_mic", ({ socketId, isMuted: peerMuted }) => {
            setPeers(prev => prev[socketId] ? { ...prev, [socketId]: { ...prev[socketId], isMuted: peerMuted } } : prev);
        });

        socket.on("user_left_voice", ({ socketId }) => {
            console.log("User left voice:", socketId);
            if (peersRef.current[socketId]) {
                peersRef.current[socketId].close();
                delete peersRef.current[socketId];
            }
            if (iceQueuesRef.current[socketId]) {
                delete iceQueuesRef.current[socketId];
            }
            const audio = document.getElementById(`audio-${socketId}`);
            if (audio) audio.remove();
            setPeers(prev => {
                const next = { ...prev };
                delete next[socketId];
                return next;
            });
        });

        return () => {
            ["voice_room_users", "user_joined_voice", "voice_signal", "voice_toggle_mic", "user_left_voice"].forEach(ev => socket.off(ev));
        };
    }, [isJoined, createPeerConnection, roomId, username]);

    useEffect(() => {
        return () => {
            if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
            Object.values(peersRef.current).forEach(pc => pc.close());
            document.querySelectorAll('audio[id^="audio-"]').forEach(a => a.remove());
        };
    }, []);

    if (!isJoined) {
        return (
            <div className="fixed bottom-6 right-6 z-50">
                <button onClick={joinVoice} className="flex items-center gap-3 bg-accent/20 hover:bg-accent/40 border border-accent/30 text-accent px-6 py-3 rounded-2xl backdrop-blur-md transition-all group shadow-xl">
                    <div className="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                    <span className="text-xs font-black uppercase tracking-widest italic">Join Voice War Room</span>
                </button>
            </div>
        );
    }

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-4">
            {/* Connection Status & Peer List */}
            <div className="flex flex-col gap-2 pointer-events-none">
                {Object.entries(peers).map(([id, peer]) => (
                    <div key={id} className="flex items-center gap-3 bg-night/80 border border-white/5 px-4 py-2 rounded-xl backdrop-blur-md shadow-lg">
                        <div className={`w-2 h-2 rounded-full ${peer.isMuted ? "bg-slate-500" : "bg-emerald-500 animate-pulse"}`}></div>
                        <div className="flex flex-col">
                            <span className="text-[10px] font-black uppercase tracking-widest text-white italic leading-tight">{peer.username}</span>
                            <span className={`text-[7px] font-bold uppercase tracking-widest ${peer.status === "connected" || peer.status === "completed" ? "text-emerald-500" : "text-amber-500"}`}>
                                {peer.status || "Init"}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            {/* Local Controls */}
            <div className="flex items-center gap-3 bg-night/95 border border-white/10 p-2 rounded-2xl backdrop-blur-xl shadow-2xl border-b-accent/40">
                <button onClick={fixSound} className="p-3 bg-white/5 hover:bg-white/10 text-white rounded-xl transition-all group relative" title="Click if you can't hear others">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                    <span className="absolute -top-8 right-0 bg-accent text-night text-[8px] font-black px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">FIX SOUND</span>
                </button>
                <div className="h-6 w-px bg-white/10"></div>
                <div className="px-3 py-1">
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isMuted ? "bg-rose-500" : "bg-emerald-500 animate-pulse"}`}></div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 italic">YOU</span>
                    </div>
                </div>
                <button 
                    onClick={toggleMute}
                    className={`p-3 rounded-xl transition-all ${isMuted ? "bg-rose-500/20 text-rose-500 hover:bg-rose-500/30" : "bg-emerald-500/20 text-emerald-500 hover:bg-emerald-500/30"}`}
                >
                    {isMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                    )}
                </button>
            </div>
        </div>
    );
}
