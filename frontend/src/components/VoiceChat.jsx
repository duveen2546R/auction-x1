import { useEffect, useRef, useState, useCallback } from "react";
import socket from "../socket";

export default function VoiceChat({ roomId, username }) {
    const [isJoined, setIsJoined] = useState(false);
    const [isMuted, setIsMuted] = useState(true);
    const [peers, setPeers] = useState({}); // { socketId: { username, isMuted } }
    
    const localStreamRef = useRef(null);
    const peersRef = useRef({}); // { socketId: RTCPeerConnection }
    const remoteStreamsRef = useRef({}); // { socketId: MediaStream }

    const createPeerConnection = useCallback((targetSocketId, isInitiator, targetUsername) => {
        // Updated ICE servers with more redundancy
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
                { urls: "stun:stun2.l.google.com:19302" },
                { urls: "stun:stun3.l.google.com:19302" },
                { urls: "stun:stun4.l.google.com:19302" },
                { urls: "stun:stun.services.mozilla.com" },
            ],
            iceCandidatePoolSize: 10,
        });

        peersRef.current[targetSocketId] = pc;
        if (targetUsername) {
            setPeers(prev => ({ ...prev, [targetSocketId]: { username: targetUsername, isMuted: true } }));
        }

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("voice_signal", {
                    to: targetSocketId,
                    signal: { type: "candidate", candidate: event.candidate },
                });
            }
        };

        pc.ontrack = (event) => {
            remoteStreamsRef.current[targetSocketId] = event.streams[0];
            
            // Remove existing audio if any
            const existingAudio = document.getElementById(`audio-${targetSocketId}`);
            if (existingAudio) existingAudio.remove();

            const audio = document.createElement("audio");
            audio.id = `audio-${targetSocketId}`;
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            // Mobile browsers often require these properties and explicit play()
            audio.playsInline = true;
            audio.muted = false; // Ensure it's not muted
            
            document.body.appendChild(audio);
            
            // Explicitly play() to handle some mobile browser restrictions
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.warn("Autoplay was prevented. User interaction might be required.", error);
                });
            }
        };

        // Add local tracks to the connection
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((track) => {
                pc.addTrack(track, localStreamRef.current);
            });
        }

        if (isInitiator) {
            pc.createOffer({ offerToReceiveAudio: true })
                .then((offer) => pc.setLocalDescription(offer))
                .then(() => {
                    socket.emit("voice_signal", {
                        to: targetSocketId,
                        signal: { type: "offer", sdp: pc.localDescription },
                    });
                })
                .catch(err => console.error("Error creating offer", err));
        }

        return pc;
    }, []);

    const joinVoice = async () => {
        // 1. Check if the context is secure (HTTPS or localhost)
        if (!window.isSecureContext) {
            alert("Microphone access requires a secure connection (HTTPS). If you are testing locally on another device, please use localhost or an HTTPS tunnel like ngrok.");
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localStreamRef.current = stream;
            // Initially muted
            stream.getAudioTracks()[0].enabled = false;
            setIsJoined(true);
            setIsMuted(true);

            // Using dedicated voice_join to avoid re-triggering join_room logic in Auction.jsx
            socket.emit("voice_join", { roomId, username });
        } catch (err) {
            console.error("Failed to get local stream", err);
            if (err.name === 'NotAllowedError') {
                alert("Microphone permission was denied. Please allow microphone access in your browser settings.");
            } else {
                alert("Could not access microphone. Ensure no other app is using it and you are on a secure (HTTPS) connection.");
            }
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

    useEffect(() => {
        if (!isJoined) return;

        socket.on("user_joined_voice", ({ socketId, username: peerName }) => {
            if (socketId === socket.id) return;
            // When someone joins, initiate a peer connection with them
            createPeerConnection(socketId, true, peerName);
        });

        socket.on("voice_signal", async ({ from, fromUsername, signal }) => {
            let pc = peersRef.current[from];
            
            // If we get a signal from someone we don't know, create a connection (as receiver)
            if (!pc) {
                pc = createPeerConnection(from, false, fromUsername);
            }

            if (signal.type === "offer") {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    socket.emit("voice_signal", {
                        to: from,
                        signal: { type: "answer", sdp: pc.localDescription },
                    });
                } catch (err) {
                    console.error("Error handling offer", err);
                }
            } else if (signal.type === "answer") {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                } catch (err) {
                    console.error("Error handling answer", err);
                }
            } else if (signal.type === "candidate") {
                try {
                    if (signal.candidate) {
                        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                    }
                } catch (e) {
                    console.error("Error adding ice candidate", e);
                }
            }
        });

        socket.on("voice_toggle_mic", ({ socketId, isMuted: peerMuted }) => {
            setPeers(prev => {
                if (!prev[socketId]) return prev;
                return { ...prev, [socketId]: { ...prev[socketId], isMuted: peerMuted } };
            });
        });

        socket.on("user_left_voice", ({ socketId }) => {
            if (peersRef.current[socketId]) {
                peersRef.current[socketId].close();
                delete peersRef.current[socketId];
            }
            if (remoteStreamsRef.current[socketId]) {
                delete remoteStreamsRef.current[socketId];
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
            socket.off("user_joined_voice");
            socket.off("voice_signal");
            socket.off("voice_toggle_mic");
            socket.off("user_left_voice");
        };
    }, [isJoined, createPeerConnection, roomId, username]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            Object.values(peersRef.current).forEach(pc => pc.close());
            // Remove all audio elements
            const audios = document.querySelectorAll('audio[id^="audio-"]');
            audios.forEach(a => a.remove());
        };
    }, []);

    if (!isJoined) {
        return (
            <div className="fixed bottom-6 right-6 z-50">
                <button 
                    onClick={joinVoice}
                    className="flex items-center gap-3 bg-accent/20 hover:bg-accent/40 border border-accent/30 text-accent px-6 py-3 rounded-2xl backdrop-blur-md transition-all group shadow-xl hover:shadow-accent/20"
                >
                    <div className="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                    <span className="text-xs font-black uppercase tracking-widest italic">Join Voice War Room</span>
                </button>
            </div>
        );
    }

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-4">
            {/* Peers List */}
            <div className="flex flex-col gap-2 pointer-events-none">
                {Object.entries(peers).map(([id, peer]) => (
                    <div key={id} className="flex items-center gap-3 bg-white/5 border border-white/5 px-4 py-2 rounded-xl backdrop-blur-md animate-slide-up shadow-lg">
                        <div className={`w-2 h-2 rounded-full ${peer.isMuted ? "bg-slate-500" : "bg-emerald-500 animate-pulse"}`}></div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-white italic">{peer.username}</span>
                    </div>
                ))}
            </div>

            {/* Local Controls */}
            <div className="flex items-center gap-3 bg-night/90 border border-white/10 p-2 rounded-2xl backdrop-blur-xl shadow-2xl border-b-accent/30">
                <div className="px-4 py-2">
                    <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${isMuted ? "bg-rose-500" : "bg-emerald-500 animate-pulse"}`}></div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 italic">
                            {username?.split(' ')[0] || "YOU"}
                        </span>
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
