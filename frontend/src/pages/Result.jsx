import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import socket from "../socket";
import { clearSession, getAuthToken } from "../session";

function validateLineup(team, ids) {
    const lineup = team.filter((p) => ids.includes(p.id));
    const roleCounts = { bat: 0, bowl: 0, wk: 0, ar: 0, overseas: 0 };
    let battingTotal = 0;
    let bowlingTotal = 0;

    lineup.forEach((p) => {
        const role = (p.role || "").toLowerCase();
        const isAr = role.includes("all");
        const isBat = role.includes("bat") || role.includes("open") || role.includes("middle");
        const isBowl = role.includes("bowl") || role.includes("pace") || role.includes("spin");
        const isWk = role.includes("keep") || role.includes("wk");
        const isOverseas = (p.country || "").toLowerCase() !== "india";
        if (isOverseas) roleCounts.overseas += 1;
        const batR = Number(p.batting_rating ?? p.rating ?? 0);
        const bowlR = Number(p.bowling_rating ?? p.rating ?? 0);
        if (isAr) {
            roleCounts.ar += 1;
            // All-rounder counts as AR only (not in Bat/Bowl categories for rule validation)
            battingTotal += batR;
            bowlingTotal += bowlR;
        } else {
            if (isBat) { roleCounts.bat += 1; battingTotal += batR; }
            if (isBowl) { roleCounts.bowl += 1; bowlingTotal += bowlR; }
            if (isWk) { roleCounts.wk += 1; roleCounts.bat += 1; battingTotal += batR; }
        }
    });

    const errors = [];
    if (ids.length !== 11) errors.push("Pick exactly 11 players");
    if (roleCounts.bat < 3) errors.push("Need at least 3 batsmen");
    if (roleCounts.bowl < 2) errors.push("Need at least 2 bowlers");
    if (roleCounts.wk < 1) errors.push("Need at least 1 wicketkeeper");
    if (roleCounts.ar > 4) errors.push("Max 4 all-rounders");
    if (roleCounts.overseas > 4) errors.push("Max 4 overseas");

    return { ok: errors.length === 0, errors, roleCounts, battingTotal, bowlingTotal };
}

export default function Result() {
    const { state } = useLocation();
    const navigate = useNavigate();
    const roomId = state?.roomId || localStorage.getItem("activeRoomId") || "";
    const [team, setTeam] = useState(Array.isArray(state?.team) ? state.team : []);
    const [isDisqualified, setIsDisqualified] = useState(Boolean(state?.disqualified));
    const [deadline, setDeadline] = useState(state?.deadline || null);
    const [selected, setSelected] = useState([]);
    const [submitting, setSubmitting] = useState(false);
    const [locked, setLocked] = useState(false);
    const [error, setError] = useState(null);
    const [results, setResults] = useState(Array.isArray(state?.results) ? state.results : null);
    const [winner, setWinner] = useState(state?.winner || null);
    const [remaining, setRemaining] = useState(null);
    const username = localStorage.getItem("username") || "You";

    const teamName = localStorage.getItem("teamName") || "";
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
        } catch {
            return null;
        }
    }, [teamName]);

    useEffect(() => {
        if (roomId) {
            localStorage.setItem("activeRoomId", roomId);
        }
    }, [roomId]);

    useEffect(() => {
        if (!roomId) return;
        const joinRoom = () => {
            socket.emit("join_room", {
                roomId,
                username,
                teamName,
                token: getAuthToken(),
                intent: "resume",
            });
        };

        joinRoom();
        socket.on("connect", joinRoom);

        return () => {
            socket.off("connect", joinRoom);
        };
    }, [roomId, username, teamName]);

    useEffect(() => {
        const onResults = (payload) => {
            setResults(payload.results);
            setWinner(payload.winner);
            setSubmitting(false);
            setLocked(true);
            setError(null);
        };
        const onErr = (payload) => {
            setError(payload.reason);
            setSubmitting(false);
        };
        const onRoomClosed = (payload) => {
            localStorage.removeItem("activeRoomId");
            if (payload?.code !== "RESULT_TIMER_ENDED") {
                alert(payload?.reason || "This room was closed.");
            }
            navigate("/");
        };
        const onJoinError = (payload) => {
            if (payload?.code?.startsWith("AUTH_")) {
                clearSession();
                navigate("/auth");
                return;
            }
            if (payload?.reason) {
                setError(payload.reason);
            }
        };

        socket.on("playing11_results", onResults);
        socket.on("playing11_error", onErr);
        socket.on("playing11_ack", (payload) => {
            setSubmitting(false);
            setLocked(true);
            setError(null);
            if (Array.isArray(payload?.playerIds)) {
                setSelected(payload.playerIds);
            }
        });
        socket.on("room_closed", onRoomClosed);
        socket.on("join_error", onJoinError);
        return () => {
            socket.off("playing11_results", onResults);
            socket.off("playing11_error", onErr);
            socket.off("playing11_ack");
            socket.off("room_closed", onRoomClosed);
            socket.off("join_error", onJoinError);
        };
    }, [navigate]);

    useEffect(() => {
        return () => {
            if (roomId) {
                socket.emit("leave_room", { roomId });
            }
        };
    }, [roomId]);

    useEffect(() => {
        if (!deadline) return;
        const tick = () => {
            const ms = deadline - Date.now();
            const rounded = ms > 0 ? Math.ceil(ms / 1000) : 0;
            setRemaining(rounded);
        };
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [deadline]);

    useEffect(() => {
        const onJoinAck = (payload) => {
            if (Array.isArray(payload.team)) setTeam(payload.team);
            if (payload.results) setResults(payload.results);
            if (payload.winner) setWinner(payload.winner);
            if (payload.deadline) setDeadline(payload.deadline);
            if (Array.isArray(payload.disqualified)) {
                setIsDisqualified(payload.disqualified.includes(teamName) || payload.disqualified.includes(username));
            }
            if (payload.roomStatus === "finished_finalized") {
                setSubmitting(false);
                setLocked(true);
                setError(null);
            } else if (payload.roomStatus === "picking") {
                setLocked(false);
            } else if (roomId) {
                navigate(`/auction/${roomId}`, { state: { username: payload.username || username, teamName: payload.teamName || teamName } });
                return;
            }
            if (Array.isArray(payload.savedPlaying11) && payload.savedPlaying11.length) {
                setSelected(payload.savedPlaying11);
                setLocked(true);
                setError(null);
            } else if (Array.isArray(payload.playing11Draft) && payload.playing11Draft.length) {
                setSelected(payload.playing11Draft);
            }
        };
        socket.on("join_ack", onJoinAck);
        return () => socket.off("join_ack", onJoinAck);
    }, [navigate, roomId, teamName, username]);

    useEffect(() => {
        if (results) {
            setLocked(true);
        }
    }, [results]);

    const deadlineExpired = remaining !== null && remaining <= 0 && !results;
    const validation = useMemo(() => validateLineup(team, selected), [team, selected]);

    useEffect(() => {
        if (!roomId || isDisqualified || locked || deadlineExpired) return;
        socket.emit("update_playing11_draft", { playerIds: selected });
    }, [roomId, selected, isDisqualified, locked, deadlineExpired]);

    const toggle = (id) => {
        if (locked || submitting || isDisqualified || deadlineExpired) return;
        if (selected.includes(id)) {
            setSelected(selected.filter((x) => x !== id));
        } else {
            if (selected.length < 11) {
                setSelected([...selected, id]);
            }
        }
    };

    const submit = () => {
        if (isDisqualified || locked || deadlineExpired) return;
        setError(null);
        const v = validateLineup(team, selected);
        if (!v.ok) {
            setError(v.errors.join(", "));
            return;
        }
        setSubmitting(true);
        socket.emit("submit_playing11", { playerIds: selected });
    };

    const downloadResults = () => {
        if (!results) return;
        let content = "AUCTION RESULTS - FINAL PLAYING XI\n";
        content += "=".repeat(40) + "\n\n";
        
        results.forEach((r, idx) => {
            const teamDisplay = r.teamName || r.username;
            content += `${idx + 1}. ${teamDisplay.toUpperCase()}\n`;
            content += `Score: ${r.score.toFixed(1)}\n`;
            if (r.playerNames && Array.isArray(r.playerNames)) {
                content += `Players: ${r.playerNames.join(", ")}\n`;
            }
            content += "-".repeat(40) + "\n\n";
        });

        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `auction_results_${new Date().getTime()}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div
            className="min-h-screen text-slate-100 px-4 py-8"
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
            <div className="max-w-7xl mx-auto space-y-8">
                {/* Header Section */}
                <header className="flex flex-col md:flex-row items-center justify-between gap-6 pb-8 border-b border-white/5">
                    <div className="flex items-center gap-6">
                        <div>
                            <h1 className="text-sm font-black text-accent tracking-[0.3em] uppercase mb-1">Squad Finalization</h1>
                            <div className="flex items-center gap-3">
                                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                                <h2 className="text-3xl font-bold tracking-tight text-white uppercase italic">
                                    THE <span className="text-slate-500">PLAYING XI</span>
                                </h2>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-4">
                        {results && (
                            <button 
                                onClick={downloadResults}
                                className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border border-emerald-500/30 rounded-lg text-xs font-black uppercase tracking-widest transition-all"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                Export Results
                            </button>
                        )}
                        <div className="h-10 w-px bg-white/10 hidden md:block"></div>
                        {remaining !== null && (
                            <div className={`flex flex-col items-end transition-all duration-300 ${remaining <= 20 ? "scale-110" : ""}`}>
                                <span className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${remaining <= 20 ? "text-rose-500 animate-pulse" : "text-slate-500"}`}>
                                    {remaining <= 20 ? "URGENT: LOCK IN NOW" : "Submission Deadline"}
                                </span>
                                <span className={`text-lg font-black italic tabular-nums ${remaining <= 20 ? "text-rose-500 scale-110 drop-shadow-[0_0_10px_rgba(244,63,94,0.5)]" : "text-rose-500"}`}>
                                    {remaining}s <span className="text-xs text-slate-500 font-medium tracking-normal not-italic">REMAINING</span>
                                </span>
                            </div>
                        )}
                        <div className="h-10 w-px bg-white/10 hidden md:block"></div>
                        <div className="flex flex-col items-end">
                            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Selected</span>
                            <span className="text-lg font-black text-white italic">{selected.length} <span className="text-xs text-slate-500 font-medium tracking-normal not-italic">/ 11 Players</span></span>
                        </div>
                    </div>
                </header>

                <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
                    <main className="space-y-8 animate-slide-up">
                        <section className="glass-card p-6 space-y-6">
                            <div className="flex items-center justify-between border-b border-white/5 pb-4">
                                <span className="text-xs font-black uppercase tracking-widest italic text-white">Squad Selection Pool</span>
                                {isDisqualified && <span className="text-[10px] font-bold uppercase tracking-widest text-rose-500">DISQUALIFIED</span>}
                            </div>

                            <div className="grid gap-3 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                                {team.map((p) => {
                                    const checked = selected.includes(p.id);
                                    const overseas = (p.country || "").toLowerCase() !== "india";
                                    return (
                                        <div 
                                            key={p.id} 
                                            className={`flex items-center justify-between p-4 rounded-2xl border transition-all cursor-pointer ${
                                                checked 
                                                ? "bg-accent/10 border-accent/30 shadow-[0_0_20px_rgba(var(--accent-rgb),0.1)]" 
                                                : "bg-white/5 border-white/5 hover:bg-white/10"
                                            } ${locked || submitting || isDisqualified || deadlineExpired ? "opacity-70 cursor-not-allowed" : ""}`}
                                            onClick={() => toggle(p.id)}
                                        >
                                            <div className="flex items-center gap-4">
                                                <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${
                                                    checked ? "bg-accent border-accent" : "border-white/20"
                                                }`}>
                                                    {checked && (
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                                    )}
                                                </div>
                                                <div className="flex flex-col">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-white font-bold text-sm uppercase italic tracking-tight">{p.name}</span>
                                                        {overseas && <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500 border border-amber-500/20 uppercase">OS</span>}
                                                    </div>
                                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{p.role}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-6">
                                                <div className="flex flex-col items-end">
                                                    <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest">BAT</span>
                                                    <span className="text-sm font-black text-white italic">⭐ {p.batting_rating ?? p.rating}</span>
                                                </div>
                                                <div className="flex flex-col items-end">
                                                    <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest">BOWL</span>
                                                    <span className="text-sm font-black text-white italic">⭐ {p.bowling_rating ?? p.rating}</span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="bg-white/5 border border-white/5 p-6 rounded-2xl space-y-6">
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                                    {[
                                        { label: "BATTERS", val: validation.roleCounts.bat, min: 3 },
                                        { label: "BOWLERS", val: validation.roleCounts.bowl, min: 2 },
                                        { label: "KEEPERS", val: validation.roleCounts.wk, min: 1 },
                                        { label: "AR", val: validation.roleCounts.ar, max: 4 },
                                        { label: "OVERSEAS", val: validation.roleCounts.overseas, max: 4 },
                                    ].map((stat, i) => (
                                        <div key={i} className="flex flex-col items-center p-3 bg-white/5 rounded-xl border border-white/5">
                                            <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest mb-1">{stat.label}</span>
                                            <span className={`text-xl font-black italic ${
                                                (stat.min && stat.val < stat.min) || (stat.max && stat.val > stat.max) 
                                                ? "text-rose-500" 
                                                : "text-accent"
                                            }`}>{stat.val}</span>
                                            {stat.min && <span className="text-[8px] text-slate-600 font-bold mt-1">MIN {stat.min}</span>}
                                            {stat.max && <span className="text-[8px] text-slate-600 font-bold mt-1">MAX {stat.max}</span>}
                                        </div>
                                    ))}
                                </div>

                                {(!validation.ok || error) && (
                                    <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl">
                                        <p className="text-xs font-bold text-rose-500 uppercase tracking-widest italic">
                                            {error ? `ERROR: ${error}` : `REQUIREMENTS: ${validation.errors.join(" | ")}`}
                                        </p>
                                    </div>
                                )}

                                <button 
                                    className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30 disabled:cursor-not-allowed" 
                                    onClick={submit} 
                                    disabled={!validation.ok || submitting || isDisqualified || locked || deadlineExpired}
                                >
                                    {deadlineExpired && !results ? (
                                        "FINALIZING RESULTS..."
                                    ) : locked ? (
                                        "PLAYING XI LOCKED"
                                    ) : submitting ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                                            AWAITING ALL TEAMS...
                                        </span>
                                    ) : (
                                        "LOCK IN PLAYING XI"
                                    )}
                                </button>
                            </div>
                        </section>
                    </main>

                    <aside className="space-y-6">
                        <section className="glass-card p-6 flex flex-col h-full">
                            <div className="flex items-center justify-between mb-6">
                                <span className="text-xs font-black uppercase tracking-widest italic text-white">Live Leaderboard</span>
                                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
                            </div>

                            <div className="flex-1 space-y-4">
                                {results ? (
                                    <>
                                        <div className="p-4 bg-accent/20 border border-accent/30 rounded-2xl mb-6">
                                            <span className="text-[10px] text-accent font-black uppercase tracking-widest">Current Winner</span>
                                            <h3 className="text-2xl font-black text-white italic uppercase tracking-tight truncate">{winner}</h3>
                                        </div>
                                        <div className="space-y-3 overflow-y-auto max-h-[800px] pr-2 custom-scrollbar">
                                            {results.map((r, idx) => (
                                                <div key={idx} className="flex justify-between items-center bg-white/5 border border-white/5 p-4 rounded-xl hover:bg-white/10 transition">
                                                    <div className="flex flex-col">
                                                        <span className="text-white font-bold text-sm uppercase italic tracking-tight">{r.teamName || r.username}</span>
                                                        <div className="flex gap-2 mt-1">
                                                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">B {r.breakdown.battingTotal}</span>
                                                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">W {r.breakdown.bowlingTotal}</span>
                                                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">P {r.breakdown.balanceBonus}</span>
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col items-end">
                                                        <span className="text-lg font-black text-accent italic tracking-tighter">{r.score.toFixed(1)}</span>
                                                        <span className="text-[8px] text-slate-600 font-bold uppercase tracking-widest">POINTS</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-64 text-center space-y-4">
                                        <div className="w-12 h-12 border-4 border-white/10 border-t-accent rounded-full animate-spin"></div>
                                        <p className="text-xs font-bold text-slate-500 uppercase tracking-[0.2em] italic">Calculations in progress...</p>
                                    </div>
                                )}
                            </div>

                            <button 
                                className="mt-8 text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 hover:text-white transition-colors flex items-center justify-center gap-2"
                                onClick={() => {
                                    localStorage.removeItem("activeRoomId");
                                    navigate("/");
                                }}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                                RETURN TO ARENA
                            </button>
                        </section>
                    </aside>
                </div>
            </div>
        </div>
    );
}
