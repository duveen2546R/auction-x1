import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import socket from "../socket";
import VoiceChat from "../components/VoiceChat";
import { clearSession, getAuthToken, getStoredUsername } from "../session";

const slugMap = {
    "royal challengers bangalore": "banglore",
    "chennai super kings": "chennai",
    "delhi capitals": "delhi",
    "gujarat titans": "gujarat",
    "sunrisers hyderabad": "hyderabad",
    "kolkata knight riders": "kolkata",
    "lucknow super giants": "lucknow",
    "mumbai indians": "mumbai",
    "punjab kings": "punjab",
    "rajasthan royals": "rajasthan",
};

export default function Lobby() {
    const { roomId } = useParams();
    const { state } = useLocation();
    const navigate = useNavigate();
    const [players, setPlayers] = useState([]);
    const [isReconnected, setIsReconnected] = useState(false);
    const [isCreator, setIsCreator] = useState(false);
    const [roomVisibility, setRoomVisibility] = useState(state?.roomVisibility || "private");
    const [creatorName, setCreatorName] = useState(null);
    const isInitialJoin = useRef(true);
    const preserveRoomOnExitRef = useRef(false);
    const didLeaveRoomRef = useRef(false);

    const username = state?.username || getStoredUsername() || "Player";
    const teamName = state?.teamName || localStorage.getItem("teamName") || "";
    const requestedVisibility = state?.roomVisibility;
    const joinIntent = state?.joinIntent || "join";
    const [error, setError] = useState(null);

    const bgSlug = useMemo(() => {
        try {
            return teamName ? slugMap[teamName.toLowerCase()] || null : null;
        } catch {
            return null;
        }
    }, [teamName]);

    const leaveRoom = useCallback(() => {
        if (!roomId || didLeaveRoomRef.current) return;
        didLeaveRoomRef.current = true;
        socket.emit("leave_room", { roomId });
        localStorage.removeItem("activeRoomId");
    }, [roomId]);

    const moveToAuction = useCallback(() => {
        preserveRoomOnExitRef.current = true;
        navigate(`/auction/${roomId}`, { state: { username, teamName } });
    }, [navigate, roomId, teamName, username]);

    useEffect(() => {
        didLeaveRoomRef.current = false;
        preserveRoomOnExitRef.current = false;
        if (roomId) {
            localStorage.setItem("activeRoomId", roomId);
        }

        return () => {
            if (!preserveRoomOnExitRef.current && !didLeaveRoomRef.current) {
                leaveRoom();
            }
        };
    }, [leaveRoom, roomId]);

    useEffect(() => {
        const joinRoom = () => {
            socket.emit("join_room", {
                roomId,
                username,
                teamName,
                visibility: requestedVisibility,
                token: getAuthToken(),
                intent: joinIntent,
            });
        };

        joinRoom();

        socket.on("connect", joinRoom);

        socket.on("join_ack", (payload) => {
            if (!isInitialJoin.current) {
                setIsReconnected(true);
                setTimeout(() => setIsReconnected(false), 3000);
            }
            isInitialJoin.current = false;

            if (typeof payload?.isCreator === "boolean") setIsCreator(payload.isCreator);
            if (payload?.roomVisibility) setRoomVisibility(payload.roomVisibility);
            if (payload?.creatorName) setCreatorName(payload.creatorName);

            if (payload.isWithdrawn || (payload.roomStatus && payload.roomStatus !== "waiting")) {
                moveToAuction();
            }
        });

        socket.on("players_update", (playerList) => {
            setPlayers(playerList);
        });

        socket.on("start_auction", moveToAuction);

        socket.on("team_taken", (payload) => {
            setError(`Team ${payload.team} already taken. Choose another team.`);
        });

        socket.on("start_auction_denied", (payload) => {
            setError(payload?.reason || "You cannot start this auction.");
        });

        socket.on("join_error", (payload) => {
            if (payload?.code === "AUTH_INVALID") {
                clearSession();
                leaveRoom();
                navigate("/auth");
                return;
            }

            if (payload?.code === "AUTH_REQUIRED_CREATE" || payload?.code === "AUTH_REQUIRED_JOIN") {
                leaveRoom();
                navigate("/auth");
                return;
            }

            setError(payload?.reason || "Unable to join this room.");
        });

        socket.on("room_closed", (payload) => {
            alert(payload?.reason || "This room was closed.");
            leaveRoom();
            navigate("/");
        });

        return () => {
            socket.off("connect", joinRoom);
            socket.off("join_ack");
            socket.off("players_update");
            socket.off("start_auction", moveToAuction);
            socket.off("team_taken");
            socket.off("start_auction_denied");
            socket.off("join_error");
            socket.off("room_closed");
        };
    }, [leaveRoom, moveToAuction, navigate, requestedVisibility, roomId, username, teamName, joinIntent]);

    const creatorLabel = creatorName || players.find((player) => player.isCreator)?.username || "Room Creator";
    const startDisabled = players.length < 2 || !isCreator;
    const startButtonLabel = !isCreator
        ? "HOST CONTROLS ONLY"
        : players.length < 2
            ? "AWAITING MORE OWNERS"
            : "INITIATE AUCTION SESSION";

    const handleStartAuction = () => {
        setError(null);
        socket.emit("start_auction", roomId);
    };

    return (
        <div
            className="min-h-screen text-slate-100 px-4 py-8 flex flex-col justify-center"
            style={
                bgSlug
                    ? {
                          backgroundImage: `linear-gradient(180deg, rgba(2,4,8,0.7) 0%, rgba(2,4,8,0.95) 100%), url(/img/${bgSlug}.png)`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                          backgroundAttachment: "fixed"
                      }
                    : { backgroundColor: "#020408" }
            }
        >
            <div className="max-w-3xl mx-auto w-full space-y-8 animate-slide-up">
                {/* Header Section */}
                <header className="flex flex-col items-center text-center gap-4 pb-8 border-b border-white/5">
                    <div>
                        <h1 className="text-sm font-black text-accent tracking-[0.4em] uppercase mb-2">Pre-Auction Briefing</h1>
                        <div className="flex flex-col items-center gap-3">
                            <div className="flex items-center gap-3">
                                <span className="w-3 h-3 rounded-full bg-rose-500 animate-pulse"></span>
                                <h2 className="text-4xl font-bold tracking-tight text-white uppercase italic">
                                    ROOM <span className="text-slate-500">{roomId}</span>
                                </h2>
                            </div>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.2em]">
                                Waiting for franchise owners to assemble
                            </p>
                            <div className="flex flex-wrap items-center justify-center gap-2">
                                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-white">
                                    {roomVisibility === "public" ? "Public Room" : "Private Room"}
                                </span>
                                <span className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] ${
                                    isCreator
                                        ? "border-accent/30 bg-accent/10 text-accent"
                                        : "border-white/10 bg-white/5 text-slate-400"
                                }`}>
                                    {isCreator ? "You Are The Host" : `Host: ${creatorLabel}`}
                                </span>
                            </div>
                        </div>
                    </div>
                </header>

                <main className="space-y-6">
                    {isReconnected && (
                        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center justify-center gap-3 animate-slide-up">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                            <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.2em] italic">Connection Restored</p>
                        </div>
                    )}
                    {error && (
                        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center">
                            <p className="text-xs font-bold text-rose-500 uppercase tracking-widest italic">{error}</p>
                        </div>
                    )}

                    <section className="glass-card p-8 space-y-8 relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-8 text-[80px] font-black italic text-white/5 select-none pointer-events-none uppercase tracking-tighter">
                            LOBBY
                        </div>

                        <div className="relative z-10 space-y-6">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-black uppercase tracking-widest italic text-white">Confirmed Participants</span>
                                <span className="text-lg font-black text-accent italic tracking-tighter">
                                    {players.length} <span className="text-[10px] text-slate-500 tracking-widest uppercase not-italic ml-1">Joined</span>
                                </span>
                            </div>

                            <div className="grid gap-3">
                                {players.map((p, i) => (
                                    <div key={i} className="flex justify-between items-center bg-white/5 border border-white/5 p-4 rounded-xl hover:bg-white/10 transition">
                                        <div className="flex flex-col">
                                            <span className="text-white font-bold text-sm uppercase italic tracking-tight">
                                                {p.username} {p.username === username && <span className="text-[10px] text-accent ml-2">(YOU)</span>}
                                            </span>
                                            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                                {p.isCreator ? "Room Creator" : "Franchise Owner"}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            {p.isCreator && (
                                                <span className="rounded-full border border-accent/20 bg-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-accent">
                                                    Host
                                                </span>
                                            )}
                                            <span className="text-xs font-black text-slate-400 uppercase italic tracking-wide">{p.team || "Independent"}</span>
                                            <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                                        </div>
                                    </div>
                                ))}
                                {players.length === 0 && (
                                    <div className="py-12 text-center italic text-slate-600 font-medium tracking-widest uppercase text-xs">
                                        Awaiting first connection...
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="relative z-10 pt-4">
                            <button
                                className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30 disabled:grayscale transition-all"
                                disabled={startDisabled}
                                onClick={handleStartAuction}
                            >
                                {startButtonLabel}
                            </button>
                            {players.length < 2 && (
                                <p className="mt-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest text-center italic">
                                    Minimum 2 franchises required to begin
                                </p>
                            )}
                            {!isCreator && (
                                <p className="mt-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest text-center italic">
                                    Only {creatorLabel} can initialize the auction
                                </p>
                            )}
                        </div>
                    </section>

                    <footer className="pt-4 flex justify-center">
                        <button 
                            className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-600 hover:text-white transition-colors flex items-center gap-2"
                            onClick={() => {
                                leaveRoom();
                                navigate("/");
                            }}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                            ABANDON SESSION
                        </button>
                    </footer>
                </main>
            </div>
            <VoiceChat roomId={roomId} username={username} />
        </div>
    );
}
