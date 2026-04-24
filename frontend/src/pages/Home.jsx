import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import socket from "../socket";
import { clearSession, getAuthToken, getStoredUsername } from "../session";

export default function Home() {
    const [roomCode, setRoomCode] = useState("");
    const [teamName, setTeamName] = useState(localStorage.getItem("teamName") || "");
    const [roomVisibility, setRoomVisibility] = useState("private");
    const [joinError, setJoinError] = useState("");
    const [teams, setTeams] = useState([]);
    const [players, setPlayers] = useState([]);
    const [publicRooms, setPublicRooms] = useState([]);
    const [sessionToken, setSessionToken] = useState(() => getAuthToken());
    const navigate = useNavigate();
    const apiBase = import.meta.env.VITE_API_URL || "http://localhost:5000";

    useEffect(() => {
        fetch(`${apiBase}/teams`)
            .then((res) => res.json())
            .then(setTeams)
            .catch(() => setTeams([]));
        fetch(`${apiBase}/players`)
            .then((r) => r.json())
            .then(setPlayers)
            .catch(() => setPlayers([]));
    }, [apiBase]);

    useEffect(() => {
        const handlePublicRoomsUpdate = (rooms) => {
            setPublicRooms(Array.isArray(rooms) ? rooms : []);
        };

        const watchPublicRooms = () => {
            socket.emit("watch_public_rooms");
        };

        watchPublicRooms();
        socket.on("connect", watchPublicRooms);
        socket.on("public_rooms_update", handlePublicRoomsUpdate);

        return () => {
            socket.off("connect", watchPublicRooms);
            socket.off("public_rooms_update", handlePublicRoomsUpdate);
            socket.emit("unwatch_public_rooms");
        };
    }, []);

    const persistTeam = (team) => {
        setTeamName(team);
        localStorage.setItem("teamName", team);
    };

    const accountUsername = getStoredUsername();
    const activeUsername = accountUsername;
    const isAuthenticated = Boolean(sessionToken);

    const openExistingRoom = (targetRoomId, openTarget) => {
        if (openTarget === "lobby") {
            navigate(`/lobby/${targetRoomId}`, {
                state: { username: activeUsername, teamName, joinIntent: "join" },
            });
            return;
        }

        navigate(`/auction/${targetRoomId}`, {
            state: { username: activeUsername, teamName },
        });
    };

    const createRoom = () => {
        const roomId = Math.floor(100000 + Math.random() * 900000);
        navigate(`/lobby/${roomId}`, { state: { username: activeUsername, teamName, roomVisibility, joinIntent: "create" } });
    };

    const handleCreateRoomClick = () => {
        if (!isAuthenticated) {
            navigate("/auth");
            return;
        }

        createRoom();
    };

    const joinRoom = async (nextRoomId = roomCode) => {
        const targetRoomId = String(nextRoomId || "").trim();
        if (!targetRoomId) return;
        setJoinError("");

        if (!isAuthenticated) {
            navigate("/auth");
            return;
        }

        if (!teamName) {
            setJoinError("Select your franchise after logging in to enter a room.");
            return;
        }

        try {
            const res = await fetch(`${apiBase}/rooms/${targetRoomId}/joinability`);
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "Unable to verify room code");
            }
            if (!data.exists) {
                setJoinError("Room code not found or already closed.");
                return;
            }

            openExistingRoom(targetRoomId, data.openTarget);
        } catch (err) {
            setJoinError(err.message || "Unable to verify room code");
        }
    };

    const handleLogout = () => {
        clearSession();
        setSessionToken("");
        navigate("/auth");
    };

    const canProceed = isAuthenticated && activeUsername && teamName;

    const grouped = useMemo(() => {
        const g = { batsman: [], bowler: [], allrounder: [], wicketkeeper: [] };
        players.forEach((p) => {
            const role = (p.role || "").toLowerCase();
            if (role.includes("all")) g.allrounder.push(p);
            else if (role.includes("keep")) g.wicketkeeper.push(p);
            else if (role.includes("bowl")) g.bowler.push(p);
            else g.batsman.push(p);
        });
        return g;
    }, [players]);

    const renderList = (title, list) => (
        <div className="glass-card border border-white/5 p-4 flex flex-col h-[300px]">
            <div className="flex justify-between items-center mb-4 border-b border-white/5 pb-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-white italic">{title}</span>
                <span className="text-[10px] font-bold text-accent">{list.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-2 custom-scrollbar">
                {list.map((p) => (
                    <div key={p.id} className="flex justify-between items-center bg-white/5 p-2 rounded-lg border border-white/5 hover:bg-white/10 transition-colors">
                        <div className="flex flex-col">
                            <span className="text-xs font-bold text-slate-200 uppercase tracking-tight">{p.name}</span>
                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">{(p.country || "").toLowerCase() !== "india" ? "Overseas" : "Indian"}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    return (
        <div className="min-h-screen text-slate-100 px-4 py-6 md:py-8 bg-[#020408] overflow-x-hidden"
            style={{
                backgroundImage: "radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.05) 0%, transparent 50%)",
                backgroundAttachment: "fixed"
            }}>
            <div className="max-w-7xl mx-auto space-y-8 md:space-y-12">
                {/* Hero Section */}
                <header className="flex flex-col items-center text-center space-y-4 md:space-y-6 py-8 md:py-12">
                    <div className="inline-flex items-center gap-3 px-4 py-1.5 rounded-full bg-accent/10 border border-accent/20 animate-fade-in">
                        <span className="w-2 h-2 rounded-full bg-accent animate-pulse"></span>
                        <span className="text-[10px] font-black uppercase tracking-[0.3em] text-accent">Season 2026 Live</span>
                    </div>
                    <div className="space-y-2">
                        <h1 className="text-4xl sm:text-6xl md:text-8xl font-black italic tracking-tighter uppercase text-white animate-slide-up">
                            AUCTIONXI <span className="text-transparent stroke-text">ARENA</span>
                        </h1>
                        <p className="text-slate-500 font-bold uppercase tracking-[0.2em] sm:tracking-[0.4em] text-[10px] sm:text-xs md:text-sm animate-slide-up delay-100 px-4">
                            The Ultimate IPL Franchise Simulator
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2 md:gap-3 px-2">
                        {isAuthenticated ? (
                            <>
                                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 md:px-4 py-2 text-[9px] md:text-[10px] font-black uppercase tracking-[0.1em] md:tracking-[0.2em] text-emerald-300">
                                    Signed In As {activeUsername}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => navigate("/history")}
                                    className="rounded-full border border-white/10 bg-white/5 px-3 md:px-4 py-2 text-[9px] md:text-[10px] font-black uppercase tracking-[0.1em] md:tracking-[0.2em] text-white transition hover:border-accent/30 hover:text-accent"
                                >
                                    Recent Rooms
                                </button>
                                <button
                                    type="button"
                                    onClick={handleLogout}
                                    className="rounded-full border border-white/10 bg-transparent px-3 md:px-4 py-2 text-[9px] md:text-[10px] font-black uppercase tracking-[0.1em] md:tracking-[0.2em] text-slate-400 transition hover:border-rose-500/30 hover:text-rose-400"
                                >
                                    Logout
                                </button>
                            </>
                        ) : (
                            <div className="flex flex-col sm:flex-row gap-3">
                                <button
                                    type="button"
                                    onClick={() => navigate("/auth")}
                                    className="rounded-full border border-accent/30 bg-accent/10 px-6 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-accent transition hover:bg-accent/20"
                                >
                                    Login to Account
                                </button>
                                <button
                                    type="button"
                                    onClick={() => navigate("/auth", { state: { initialIsLogin: false } })}
                                    className="rounded-full border border-white/20 bg-white/5 px-6 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white transition hover:bg-white/10 hover:border-white/30"
                                >
                                    Register Account
                                </button>
                            </div>
                        )}
                    </div>
                </header>

                <div className="grid lg:grid-cols-[1fr_400px] gap-6 md:gap-8">
                    <main className="space-y-6 md:space-y-8 animate-slide-up delay-200">
                        {/* Configuration Card */}
                        <section className="glass-card p-6 md:p-8 space-y-8 relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-8 text-6xl sm:text-8xl md:text-[100px] font-black italic text-white/5 select-none pointer-events-none uppercase tracking-tighter">
                                JOIN
                            </div>

                            <div className="relative z-10 grid md:grid-cols-2 gap-6 md:gap-8">
                                <div className="space-y-6">
                                    <div className="space-y-4">
                                        <div className="flex flex-col">
                                            <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2">Franchise Owner</label>
                                            <input
                                                className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
                                                placeholder="Login required"
                                                value={activeUsername}
                                                readOnly
                                                disabled
                                            />
                                            <div className="mt-2 flex flex-col gap-1">
                                                <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300">
                                                    {isAuthenticated
                                                        ? "Account username is locked to your signed-in profile."
                                                        : "Log in first. Joining any room now requires an account."}
                                                </p>
                                                {!isAuthenticated && (
                                                    <button 
                                                        onClick={() => navigate("/auth", { state: { initialIsLogin: false } })}
                                                        className="text-[10px] font-black text-accent uppercase tracking-widest hover:underline text-left"
                                                    >
                                                        Don't have an account? Register here
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex flex-col">
                                            <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2">Select Franchise</label>
                                            <select
                                                className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent transition-all appearance-none"
                                                value={teamName}
                                                onChange={(e) => persistTeam(e.target.value)}
                                                disabled={!isAuthenticated}
                                            >
                                                <option value="" disabled className="bg-night">Choose your legacy...</option>
                                                {teams.map((t) => (
                                                    <option key={t.id} value={t.name} className="bg-night">{t.name.toUpperCase()}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="space-y-3">
                                            <div className="flex items-center justify-between">
                                                <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em]">Room Access</label>
                                                <span className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">
                                                    {roomVisibility === "public" ? "Visible in lobby list" : "Invite only"}
                                                </span>
                                            </div>
                                            <div className="grid grid-cols-2 gap-3">
                                                {["private", "public"].map((visibility) => {
                                                    const isActive = roomVisibility === visibility;
                                                    return (
                                                        <button
                                                            key={visibility}
                                                            type="button"
                                                            onClick={() => setRoomVisibility(visibility)}
                                                            className={`rounded-xl border px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition-all ${isActive
                                                                ? "border-accent bg-accent/15 text-white"
                                                                : "border-white/5 bg-white/5 text-slate-400 hover:border-white/15 hover:text-white"
                                                                }`}
                                                        >
                                                            {visibility}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30 transition-all"
                                        onClick={handleCreateRoomClick}
                                        disabled={isAuthenticated ? !canProceed : false}
                                    >
                                        {isAuthenticated ? "CREATE NEW SESSION" : "LOGIN TO CREATE SESSION"}
                                    </button>
                                    {!isAuthenticated && (
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">
                                            Room creation is available only for logged-in accounts so the full room history can be saved.
                                        </p>
                                    )}
                                </div>

                                <div className="p-4 md:p-6 bg-white/5 rounded-2xl border border-white/5 border-dashed space-y-6">
                                    <div className="space-y-4">
                                        <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em]">Join Existing Arena</label>
                                        <input
                                            className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-accent transition-all text-center tracking-[0.3em] sm:tracking-[0.5em] font-black"
                                            placeholder="XXXXXX"
                                            value={roomCode}
                                            onChange={(e) => {
                                                setRoomCode(e.target.value);
                                                setJoinError("");
                                            }}
                                        />
                                        <button
                                            className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30 transition-all"
                                            onClick={() => joinRoom()}
                                            disabled={!roomCode}
                                        >
                                            {isAuthenticated ? "ENTER ROOM" : "LOGIN TO JOIN ROOM"}
                                        </button>
                                        {joinError && (
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-rose-400">
                                                {joinError}
                                            </p>
                                        )}
                                    </div>

                                    <div className="border-t border-white/5 pt-6 space-y-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex-1">
                                                <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white italic">Live Public Lobbies</h3>
                                                <p className="text-[9px] sm:text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">
                                                    Visible only while hosts are waiting in the lobby
                                                </p>
                                            </div>
                                            <span className="shrink-0 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-300">
                                                {publicRooms.length} Live
                                            </span>
                                        </div>

                                        <div className="space-y-3 max-h-[240px] overflow-y-auto pr-1 custom-scrollbar">
                                            {publicRooms.map((room) => (
                                                <button
                                                    key={room.roomId}
                                                    type="button"
                                                    onClick={() => joinRoom(room.roomId)}
                                                    className="w-full rounded-2xl border border-white/5 bg-black/20 p-4 text-left transition hover:border-accent/30 hover:bg-white/5"
                                                >
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="text-xs font-black uppercase tracking-[0.2em] text-white italic">
                                                            Room {room.roomId}
                                                        </span>
                                                        <span className="text-[10px] font-black uppercase tracking-widest text-accent">
                                                            {room.participantCount} Owners
                                                        </span>
                                                    </div>
                                                    <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                                        Host: {room.creatorName || "Host"}
                                                        {room.creatorTeamName ? ` · ${room.creatorTeamName}` : ""}
                                                    </p>
                                                </button>
                                            ))}

                                            {publicRooms.length === 0 && (
                                                <div className="rounded-2xl border border-white/5 bg-black/20 px-4 py-6 text-center">
                                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 italic">
                                                        No public lobbies waiting right now
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        {!isAuthenticated && publicRooms.length > 0 && (
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">
                                                Sign in first to join a live public lobby.
                                            </p>
                                        )}
                                        {isAuthenticated && !teamName && publicRooms.length > 0 && (
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">
                                                Select your franchise after logging in to join a live public lobby.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Comprehensive Rulebook */}
                        <section className="glass-card p-6 md:p-8 space-y-8">
                            <div className="flex items-center justify-between border-b border-white/5 pb-4">
                                <div>
                                    <span className="text-xs font-black uppercase tracking-widest italic text-white">The Official Rulebook</span>
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Master the mechanics of the auction</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <h4 className="text-[10px] font-black text-accent uppercase tracking-widest flex items-center gap-2">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                                            Squad Composition
                                        </h4>
                                        <ul className="space-y-2 text-xs text-slate-300 font-medium leading-relaxed bg-white/5 p-4 rounded-xl border border-white/5">
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Exact 11 players required for the final Playing XI submission.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Mandatory minimums: 3 pure Batsmen, 2 pure Bowlers, 1 Wicketkeeper.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Limits: Maximum 4 All-rounders. Maximum 4 Overseas (OS) players.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> All-rounders fulfill their own category and do NOT count towards minimum Bat/Bowl constraints.</li>
                                        </ul>
                                    </div>

                                    <div className="space-y-2">
                                        <h4 className="text-[10px] font-black text-accent uppercase tracking-widest flex items-center gap-2">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                                            Financial & Bidding Tiers
                                        </h4>
                                        <ul className="space-y-2 text-xs text-slate-300 font-medium leading-relaxed bg-white/5 p-4 rounded-xl border border-white/5">
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Franchise starting purse is strict at ₹120.00 Cr.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Base Price to ₹10 Cr: Increment is ₹0.20 Cr.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Above ₹10 Cr: Increment is ₹0.50 Cr.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> No consecutive self-bidding allowed.</li>
                                        </ul>
                                    </div>
                                </div>

                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <h4 className="text-[10px] font-black text-accent uppercase tracking-widest flex items-center gap-2">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                            Auction Dynamics
                                        </h4>
                                        <ul className="space-y-2 text-xs text-slate-300 font-medium leading-relaxed bg-white/5 p-4 rounded-xl border border-white/5">
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> <strong>Timer:</strong> Player is sold if no new bids are placed after the "Going Twice" warning (~13 seconds).</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> <strong>Pass:</strong> Opt out of the current player. Requires a <strong>Double Click</strong> or press <strong>'P'</strong> on your keyboard.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> <strong>Withdraw:</strong> Exit the auction session permanently. Press <strong>'W'</strong> on your keyboard.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> <strong>Shortcuts:</strong> <strong>'B'</strong> to Bid, <strong>'P'</strong> to Pass, <strong>'S'</strong> to Skip Pool, <strong>'W'</strong> to Withdraw.</li>
                                        </ul>
                                    </div>

                                    <div className="space-y-2">
                                        <h4 className="text-[10px] font-black text-accent uppercase tracking-widest flex items-center gap-2">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                                            Victory & Scoring System
                                        </h4>
                                        <ul className="space-y-2 text-xs text-slate-300 font-medium leading-relaxed bg-white/5 p-4 rounded-xl border border-white/5">
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Post-auction, you have <strong>2 minutes</strong> to submit a valid Playing XI.</li>
                                            <li className="flex items-start gap-2"><span className="text-rose-500 font-bold">• DISQUALIFICATION:</span> Occurs if your total drafted squad cannot mathematically form a valid XI.</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> <strong>Formula:</strong> Total Batting Rating (45%) + Total Bowling Rating (45%) + Squad Balance Bonus (10%).</li>
                                            <li className="flex items-start gap-2"><span className="text-accent">•</span> Highest scoring valid Playing XI claims the Arena Championship.</li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Player Pool Preview */}
                        <section className="space-y-6">
                            <div className="flex items-center justify-between border-b border-white/5 pb-4">
                                <span className="text-xs font-black uppercase tracking-widest italic text-white">Market Player Pool Preview</span>
                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{players.length} Total Drafts</span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                {renderList("Batsmen", grouped.batsman)}
                                {renderList("All-rounders", grouped.allrounder)}
                                {renderList("Bowlers", grouped.bowler)}
                                {renderList("Wicketkeepers", grouped.wicketkeeper)}
                            </div>
                        </section>
                    </main>

                    <aside className="space-y-8 animate-slide-up delay-300">
                        <section className="glass-card p-6 space-y-6">
                            <h3 className="text-xs font-black uppercase tracking-widest italic text-white border-b border-white/5 pb-4">How to Play</h3>
                            <div className="space-y-4">
                                {[
                                    { step: "1", title: "Form a Lobby", desc: "Create a room and share the 6-digit code with friends." },
                                    { step: "2", title: "Draft Strategy", desc: "Review the player pool. Minimum 2 franchises required to start." },
                                    { step: "3", title: "Bidding War", desc: "Outbid rivals in real-time. Manage your ₹120Cr purse carefully." },
                                    { step: "4", title: "Final Selection", desc: "Submit your best mathematically valid Playing XI within 2 minutes." },
                                    { step: "5", title: "Crowning", desc: "The algorithm calculates ratings. The highest score wins." }
                                ].map((item, i) => (
                                    <div key={i} className="flex gap-4 items-start">
                                        <div className="w-6 h-6 shrink-0 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center text-[10px] font-black text-accent italic">
                                            {item.step}
                                        </div>
                                        <div className="flex flex-col pt-0.5">
                                            <span className="text-[10px] font-black text-white italic uppercase tracking-widest">{item.title}</span>
                                            <p className="text-[10px] text-slate-400 font-medium leading-relaxed mt-1">{item.desc}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <section className="glass-card p-6 space-y-6">
                            <h3 className="text-xs font-black uppercase tracking-widest italic text-white border-b border-white/5 pb-4">Pro Tips</h3>
                            <ul className="space-y-4">
                                <li className="flex flex-col gap-1">
                                    <span className="text-[10px] font-black text-emerald-400 italic uppercase">The All-Rounder Hack</span>
                                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed">All-rounders contribute full points to BOTH batting and bowling totals, making them highly valuable for score maxing.</p>
                                </li>
                                <li className="flex flex-col gap-1">
                                    <span className="text-[10px] font-black text-amber-400 italic uppercase">Purse Management</span>
                                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed">Don't blow your budget early. A balanced 11 of mid-tier players often beats a team with 3 stars and 8 fillers.</p>
                                </li>
                                <li className="flex flex-col gap-1">
                                    <span className="text-[10px] font-black text-sky-400 italic uppercase">The Disqualification Trap</span>
                                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed">Always track your roles. If you run out of funds without securing a Wicketkeeper, your entire squad is disqualified.</p>
                                </li>
                            </ul>
                        </section>

                        <section className="glass-card p-6 bg-accent/5 border-accent/10">
                            <div className="flex flex-col gap-4 italic">
                                <p className="text-sm text-slate-300 font-medium leading-relaxed">
                                    "Auction wars are won in the margins—every bid is a story. Build balance, not just stars. Champions are crafted, not collected."
                                </p>
                                <span className="text-[10px] font-black uppercase tracking-widest text-accent">— ARENA CHRONICLES</span>
                            </div>
                        </section>
                    </aside>
                </div>

                <footer className="text-center py-8 border-t border-white/5">
                    <p className="text-[10px] text-slate-600 font-bold uppercase tracking-[0.4em]">
                        Developed by Duveen Kumar Reddy Rachapalli
                    </p>
                </footer>
            </div>
        </div>
    );
}
