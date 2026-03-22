import { useEffect, useState, useMemo } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import socket from "../socket";

export default function Lobby() {
    const { roomId } = useParams();
    const { state } = useLocation();
    const navigate = useNavigate();
    const [players, setPlayers] = useState([]);

    const username = state?.username || localStorage.getItem("username") || "Player";
    const teamName = state?.teamName || localStorage.getItem("teamName") || "";
    const [error, setError] = useState(null);

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
    
    const bgSlug = useMemo(() => {
        try {
            return teamName ? slugMap[teamName.toLowerCase()] || null : null;
        } catch (e) {
            return null;
        }
    }, [teamName]);

    useEffect(() => {
        socket.emit("join_room", { roomId, username, teamName });

        socket.on("players_update", (playerList) => {
            setPlayers(playerList);
        });

        socket.on("start_auction", () => {
            navigate(`/auction/${roomId}`, { state: { username, teamName } });
        });

        socket.on("team_taken", (payload) => {
            setError(`Team ${payload.team} already taken. Choose another team.`);
        });

        return () => socket.off();
    }, [navigate, roomId, username, teamName]);

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
                        </div>
                    </div>
                </header>

                <main className="space-y-6">
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
                                            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Franchise Owner</span>
                                        </div>
                                        <div className="flex items-center gap-4">
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
                                disabled={players.length < 2}
                                onClick={() => socket.emit("start_auction", roomId)}
                            >
                                {players.length < 2 ? "AWAITING MORE OWNERS" : "INITIATE AUCTION SESSION"}
                            </button>
                            {players.length < 2 && (
                                <p className="mt-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest text-center italic">
                                    Minimum 2 franchises required to begin
                                </p>
                            )}
                        </div>
                    </section>

                    <footer className="pt-4 flex justify-center">
                        <button 
                            className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-600 hover:text-white transition-colors flex items-center gap-2"
                            onClick={() => navigate("/")}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                            ABANDON SESSION
                        </button>
                    </footer>
                </main>
            </div>
        </div>
    );
}

