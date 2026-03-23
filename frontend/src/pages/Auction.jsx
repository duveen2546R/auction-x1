import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import socket from "../socket";
import PlayerCard from "../components/PlayerCard";
import BidPanel from "../components/BidPanel";
import TeamList from "../components/TeamList";
import PlayerStatusList from "../components/PlayerStatusList";
import TeamPurses from "../components/TeamPurses";
import Timer from "../components/Timer";
import VoiceChat from "../components/VoiceChat";

export default function Auction() {
    const { state } = useLocation();
    const { roomId } = useParams();
    const navigate = useNavigate();
    const username = state?.username || localStorage.getItem("username") || "You";
    const teamName = state?.teamName || localStorage.getItem("teamName") || "";
    
    // Safety check for userId initialization
    const storedUserId = localStorage.getItem("userId");
    const initialUserId = storedUserId && storedUserId !== "undefined" && storedUserId !== "null" 
        ? Number(storedUserId) 
        : null;
    const [userId, setUserId] = useState(initialUserId);

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

    const [currentPlayer, setCurrentPlayer] = useState(null);
    const [currentBid, setCurrentBid] = useState(0);
    const [lastBidder, setLastBidder] = useState(null);
    const [team, setTeam] = useState([]);
    const [warning, setWarning] = useState(null);
    const [hasPassed, setHasPassed] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [lastMyBid, setLastMyBid] = useState(null);
    const [eliminated, setEliminated] = useState(false);
    const [isSpectator, setIsSpectator] = useState(false);
    const [bidHistory, setBidHistory] = useState([]);
    const [step, setStep] = useState(0.1);
    const [budget, setBudget] = useState(100);
    const [chat, setChat] = useState([]);
    const [chatInput, setChatInput] = useState("");
    const [queueInfo, setQueueInfo] = useState({ remaining: null, completed: null, next: [] });
    const [playerStatus, setPlayerStatus] = useState({ sold: [], remaining: [], unsold: [], updatedAt: null });
    const [purses, setPurses] = useState([]);
    const [soldOverlay, setSoldOverlay] = useState(null);
    const [setTransition, setSetTransition] = useState(null);
    const [withdrawOverlay, setWithdrawOverlay] = useState(false);
    const [passOverlay, setPassOverlay] = useState(false);
    const [unsoldOverlay, setUnsoldOverlay] = useState(null);
    const [reconnectOverlay, setReconnectOverlay] = useState(false);
    const [timeLeft, setTimeLeft] = useState({ percent: 100, ms: 13000 });
    const isInitialJoin = useRef(true);
    const countdownAudio = useRef(new Audio("/countdown.mp3"));

    const apiBase = useMemo(() => import.meta.env.VITE_API_URL || "http://localhost:5000", []);

    useEffect(() => {
        if (username) localStorage.setItem("username", username);
        if (teamName) localStorage.setItem("teamName", teamName);
        if (userId) localStorage.setItem("userId", String(userId));
    }, [username, teamName, userId]);

    const refreshPlayerStatus = useCallback(async () => {
        if (!roomId) return;
        try {
            const qs = new URLSearchParams();
            if (userId) qs.set("userId", String(userId));
            else qs.set("user", username);
            const res = await fetch(`${apiBase}/rooms/${roomId}/players-status?${qs.toString()}`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            const data = await res.json();
            
            setPlayerStatus({
                sold: Array.isArray(data.sold) ? data.sold : [],
                remaining: Array.isArray(data.remaining) ? data.remaining : [],
                unsold: Array.isArray(data.unsold) ? data.unsold : [],
                updatedAt: Date.now(),
            });

            if (data.counts) {
                setQueueInfo((prev) => ({
                    ...prev,
                    completed: typeof data.counts.sold === 'number' ? data.counts.sold : prev.completed,
                    remaining: typeof data.counts.remaining === 'number' ? data.counts.remaining : prev.remaining,
                }));
            }
            if (Array.isArray(data.userTeam)) setTeam(data.userTeam);
            if (typeof data.userBudget === "number") setBudget(Number(data.userBudget));
        } catch (err) {
            console.warn("Failed to load player status", err.message);
        }
    }, [apiBase, roomId, username, userId]);

    const refreshPurses = useCallback(async () => {
        if (!roomId) return;
        try {
            const res = await fetch(`${apiBase}/rooms/${roomId}/purses`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            const data = await res.json();
            const nextPurses = Array.isArray(data.purses) ? data.purses : [];
            setPurses(nextPurses);
            
            const ownPurse = nextPurses.find((entry) => Number(entry.userId) === Number(userId));
            if (ownPurse && typeof ownPurse.budget !== "undefined") {
                setBudget(Number(ownPurse.budget));
            }
        } catch (err) {
            console.warn("Failed to load purses", err.message);
        }
    }, [apiBase, roomId, userId]);

    useEffect(() => {
        const joinRoom = () => {
            if (roomId) {
                socket.emit("join_room", { roomId, username, teamName });
            }
        };

        joinRoom();

        socket.on("connect", joinRoom);

        socket.on("new_player", (player) => {
            if (!player) return;
            countdownAudio.current.pause();
            countdownAudio.current.currentTime = 0;
            setCurrentPlayer(player);
            setCurrentBid(Number(player.base_price || 0));
            setLastBidder(null);
            setWarning(null);
            setTimeLeft({ percent: 100, ms: 13000 });
            const base = Number(player.base_price || 0);
            setStep(base < 12 ? 0.1 : base < 20 ? 0.25 : 0.5);
        });

        socket.on("bid_update", (payload) => {
            if (!payload) return;
            const amount = Number(payload.amount || 0);
            const rounded = Math.round(amount * 100) / 100;
            setCurrentBid(rounded);
            setLastBidder(payload.by);
            setWarning(null);
            setTimeLeft({ percent: 100, ms: 13000 });
            if (Array.isArray(payload.history)) setBidHistory(payload.history);
            if (payload.step) setStep(Number(payload.step));
        });

        socket.on("player_won", (data) => {
            if (!data) return;
            countdownAudio.current.pause();
            countdownAudio.current.currentTime = 0;
            const currentUserWon =
                Number(data?.winnerUserId) === Number(userId) ||
                (!data?.winnerUserId && data?.winner === username);

            if (currentUserWon) {
                setTeam((prev) => (prev.some((p) => p.id === data.player?.id) ? prev : [...prev, data.player]));
                if (typeof data?.budget === "number") {
                    setBudget(Number(data.budget));
                }
            }

            if (data.winner) {
                setSoldOverlay({
                    playerName: data.player?.name || "Player",
                    winner: data.winner,
                    price: Number(data.price || 0)
                });
                setTimeout(() => setSoldOverlay(null), 3000);
            } else {
                setUnsoldOverlay({
                    playerName: data.player?.name || "Player"
                });
                setTimeout(() => setUnsoldOverlay(null), 2500);
            }

            setWarning(null);
            setHasPassed(false);
            setLastMyBid(null);
            if (eliminated) setEliminated(true);
            setBidHistory([]);
            refreshPlayerStatus();
            refreshPurses();
        });

        socket.on("set_transition", (payload) => {
            if (payload?.setName) {
                setSetTransition(payload.setName);
                setTimeout(() => setSetTransition(null), 4000);
            }
        });

        socket.on("auction_complete", (payload) => {
            setTeam(currentTeam => {
                navigate("/result", {
                    state: {
                        team: currentTeam,
                        disqualified: Array.isArray(payload?.disqualified) ? payload.disqualified.includes(username) : false,
                        deadline: payload?.deadline || null,
                    },
                });
                return currentTeam;
            });
        });

        socket.on("bid_warning", (payload) => {
            if (!payload) return;
            if (payload.stage === "once") setWarning(`Going once for ${payload.by || "current bid"}...`);
            if (payload.stage === "twice") setWarning(`Going twice for ${payload.by || "current bid"}...`);
        });

        socket.on("chat_message", (msg) => {
            if (msg) setChat((c) => [...c.slice(-50), msg]);
        });

        socket.on("timer_tick", (data) => {
            if (data) {
                setTimeLeft({ percent: data.percent, ms: data.remainingMs });
                
                // Play countdown for last 5 seconds
                if (data.remainingMs <= 5000 && data.remainingMs > 0) {
                    if (countdownAudio.current.paused) {
                        countdownAudio.current.currentTime = 0;
                        countdownAudio.current.play().catch(e => console.warn("Audio play blocked", e));
                    }
                } else {
                    // Stop audio if bid increases timer or reaches 0
                    countdownAudio.current.pause();
                    countdownAudio.current.currentTime = 0;
                }
            }
        });

        socket.on("budget_update", (b) => {
            if (typeof b?.budget === "number") setBudget(Number(b.budget));
        });

        socket.on("purses_update", (payload) => {
            const nextPurses = Array.isArray(payload?.purses) ? payload.purses : [];
            setPurses(nextPurses);
            const ownPurse = nextPurses.find((entry) => Number(entry.userId) === Number(userId));
            if (ownPurse && typeof ownPurse.budget !== "undefined") {
                setBudget(Number(ownPurse.budget));
            }
        });

        socket.on("queue_update", (q) => {
            if (q) setQueueInfo(q);
        });

        socket.on("join_ack", (payload) => {
            if (!payload) return;
            
            if (!isInitialJoin.current) {
                setReconnectOverlay(true);
                setTimeout(() => setReconnectOverlay(false), 3000);
            }
            isInitialJoin.current = false;

            if (payload.userId) setUserId(payload.userId);
            if (Array.isArray(payload.team)) setTeam(payload.team);
            if (typeof payload.budget === "number") setBudget(Number(payload.budget));
            if (payload.queue) setQueueInfo(payload.queue);
            if (Array.isArray(payload.bidHistory)) setBidHistory(payload.bidHistory);
            if (typeof payload.isSpectator === "boolean") setIsSpectator(payload.isSpectator);
            
            if (payload.isWithdrawn) {
                setEliminated(true);
            }

            if (payload.currentPlayer) {
                const player = payload.currentPlayer;
                setCurrentPlayer(player);
                const bid = typeof payload.currentBid === "number" ? payload.currentBid : Number(player.base_price || 0);
                setCurrentBid(bid);
                setLastBidder(payload.lastBidder || null);
                setWarning(null);
            }
        });

        refreshPlayerStatus();
        refreshPurses();
        const poll = setInterval(() => {
            refreshPlayerStatus();
            refreshPurses();
        }, 8000);

        return () => {
            countdownAudio.current.pause();
            socket.off("connect", joinRoom);
            socket.off();
            clearInterval(poll);
        };
    }, [navigate, roomId, username, teamName, refreshPlayerStatus, refreshPurses, userId]);

    const placeBid = (amount) => {
        if (eliminated || isSpectator) return;
        socket.emit("place_bid", amount);
        const rounded = Math.round(Number(amount) * 100) / 100;
        setLastMyBid(rounded);
    };

    const withdraw = () => {
        if (isSpectator) return;
        const confirmed = window.confirm("Are you sure you want to withdraw from the auction? You will be disqualified and can only rejoin as a viewer.");
        if (!confirmed) return;
        
        setEliminated(true);
        setWithdrawOverlay(true);
        socket.emit("withdraw_bid");
        
        setTimeout(() => {
            setWithdrawOverlay(false);
        }, 3000);
    };

    const passPlayer = () => {
        if (hasPassed || isSpectator) return;
        setHasPassed(true);
        setPassOverlay(true);
        socket.emit("pass_player");
        setTimeout(() => setPassOverlay(false), 1500);
    };

    const sendChat = () => {
        const text = chatInput.trim();
        if (!text) return;
        socket.emit("chat_message", { roomId, text });
        setChatInput("");
    };

    const completedCount = Number(queueInfo.completed ?? playerStatus?.sold?.length ?? 0);
    const remainingCount = Number(queueInfo.remaining ?? playerStatus?.remaining?.length ?? 0);
    const totalCount = completedCount + remainingCount;

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
                    : {}
            }
        >
            <div className="max-w-7xl mx-auto space-y-8">
                {isSpectator && (
                    <div className="bg-slate-500/10 border border-slate-500/20 p-4 rounded-2xl flex items-center justify-between animate-pulse">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-slate-500"></div>
                            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 italic">Spectator Mode Active</span>
                        </div>
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest uppercase">You joined after the auction started</span>
                    </div>
                )}
                {/* Header Section */}
                <header className="flex flex-col md:flex-row items-center justify-between gap-6 pb-8 border-b border-white/5">
                    <div className="flex items-center gap-6">
                        {!sidebarOpen && (
                            <button className="primary-btn !px-4 !py-2.5 !rounded-xl text-[10px] font-black tracking-widest uppercase flex items-center gap-2 shadow-accent/20" onClick={() => setSidebarOpen(true)}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
                                Show Panel
                            </button>
                        )}
                        <div>
                            <h1 className="text-sm font-black text-accent tracking-[0.3em] uppercase mb-1">Live Auction Session</h1>
                            <div className="flex items-center gap-3">
                                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
                                <h2 className="text-3xl font-bold tracking-tight text-white uppercase italic">
                                    {roomId || "ROOM"} <span className="text-slate-500">POOL</span>
                                </h2>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-8">
                        <div className="flex flex-col items-end">
                            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Progress</span>
                            <span className="text-lg font-black text-white italic">{completedCount} <span className="text-xs text-slate-500 font-medium tracking-normal not-italic">/ {totalCount} Players</span></span>
                        </div>
                        <div className="h-10 w-px bg-white/10 hidden md:block"></div>
                        <div className="flex flex-col items-end">
                            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Current Set</span>
                            <span className="text-sm font-black text-white italic tracking-wide uppercase">{currentPlayer?.setName || "—"}</span>
                        </div>
                    </div>
                </header>

                <div className={`grid gap-8 transition-all duration-500 ${sidebarOpen ? "lg:grid-cols-[380px_1fr]" : "lg:grid-cols-1"}`}>
                    {sidebarOpen && (
                        <aside className="space-y-6 animate-slide-up">
                            <div className="flex items-center justify-between bg-white/5 p-4 rounded-2xl border border-white/5">
                                <span className="text-xs font-black uppercase tracking-widest italic text-white">Squad Profile</span>
                                <button 
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-rose-500/10 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-rose-500 border border-white/5 hover:border-rose-500/20 transition-all duration-300 group" 
                                    onClick={() => setSidebarOpen(false)}
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-50 group-hover:opacity-100 transition-opacity">
                                        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
                                    Hide Panel
                                </button>
                            </div>
                            <TeamList team={team} budget={budget} />
                            <PlayerStatusList
                                sold={playerStatus.sold}
                                remaining={playerStatus.remaining}
                                unsold={playerStatus.unsold}
                                currentId={currentPlayer?.id}
                            />
                        </aside>
                    )}

                    <main className="space-y-8">
                        {/* Current Player Card */}
                        <section className="space-y-4">
                            {currentPlayer ? (
                                <>
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="bg-accent/10 text-accent text-[10px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-lg border border-accent/20">
                                            Current Set: {currentPlayer.setName}
                                        </span>
                                    </div>
                                    <PlayerCard player={currentPlayer} />
                                </>
                            ) : (
                                <div className="glass-card p-20 flex flex-col justify-center items-center gap-4 animate-pulse">
                                    <div className="w-12 h-12 border-4 border-accent/20 border-t-accent rounded-full animate-spin"></div>
                                    <div className="italic text-slate-500 font-bold tracking-widest uppercase text-center text-xs">
                                        {queueInfo.completed != null || queueInfo.remaining != null 
                                            ? "Synchronizing Live Auction State..." 
                                            : "Awaiting Next Player Selection..."}
                                    </div>
                                </div>
                            )}
                        </section>

                        {/* Bid Controls */}
                        <section className="glass-card p-8 space-y-8 relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-8 text-[100px] font-black italic text-white/5 select-none pointer-events-none uppercase tracking-tighter">
                                BIDDING
                            </div>

                            <div className="relative z-10 flex flex-col md:flex-row justify-between items-end gap-8">
                                <div className="space-y-4">
                                    <div className="flex flex-col">
                                        <span className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2">Current Bid Leader</span>
                                        <h3 className="text-4xl font-black text-white italic uppercase tracking-tight">
                                            {lastBidder || <span className="text-slate-700">NO BIDS</span>}
                                        </h3>
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2">Current Valuation</span>
                                        <span className="text-5xl font-black text-accent italic tracking-tighter">
                                            ₹{Number(currentBid || 0).toFixed(2)} <span className="text-lg">Cr</span>
                                        </span>
                                    </div>
                                </div>
                                
                                <div className="w-full md:w-auto">
                                    {warning && (
                                        <div className="mb-4 px-4 py-2 bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs font-black uppercase tracking-widest italic animate-pulse">
                                            {warning}
                                        </div>
                                    )}
                                    <div className="mb-6">
                                        <Timer percent={timeLeft.percent} ms={timeLeft.ms} />
                                    </div>
                                    <BidPanel
                                        currentBid={currentBid}
                                        step={step}
                                        budget={budget}
                                        onBid={placeBid}
                                        onWithdraw={withdraw}
                                        onPass={passPlayer}
                                        isPassed={hasPassed}
                                        isEliminated={eliminated}
                                        isSpectator={isSpectator}
                                        hasBidder={!!lastBidder}
                                    />
                                </div>
                            </div>
                        </section>

                        {/* Bid History & Chat */}
                        <section className="grid md:grid-cols-2 gap-8">
                            <div className="glass-card p-6 flex flex-col h-[400px]">
                                <div className="flex items-center justify-between mb-6">
                                    <span className="text-xs font-black uppercase tracking-widest italic text-white">Live Bidding History</span>
                                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                                </div>
                                <div className="flex-1 overflow-y-auto pr-2 space-y-3">
                                    {Array.isArray(bidHistory) && bidHistory.length === 0 && (
                                        <div className="h-full flex flex-col items-center justify-center text-slate-600 italic">
                                            Awaiting first bid...
                                        </div>
                                    )}
                                    {Array.isArray(bidHistory) && bidHistory.slice().reverse().map((h, i) => (
                                        <div key={i} className="flex justify-between items-center bg-white/5 border border-white/5 p-3 rounded-xl hover:bg-white/10 transition">
                                            <div className="flex flex-col">
                                                <span className="text-white font-bold text-sm uppercase italic tracking-tight">{h.by || "—"}</span>
                                                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{h.note || "BID"}</span>
                                            </div>
                                            <span className="text-lg font-black text-accent italic tracking-tighter">₹{h.amount} Cr</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="glass-card p-6 flex flex-col h-[400px]">
                                <div className="flex items-center justify-between mb-6">
                                    <span className="text-xs font-black uppercase tracking-widest italic text-white">War Room Chat</span>
                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">LIVE CONNECTION</span>
                                </div>
                                <div className="flex-1 overflow-y-auto pr-2 space-y-4 mb-6">
                                    {Array.isArray(chat) && chat.map((m, i) => (
                                        <div key={i} className="flex flex-col gap-1">
                                            <span className="text-[10px] font-black uppercase tracking-widest text-accent italic">{m.user}</span>
                                            <div className="bg-white/5 p-3 rounded-2xl rounded-tl-none border border-white/5 text-slate-200 text-sm leading-relaxed">
                                                {m.text}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex gap-2 text-night">
                                    <input
                                        className="flex-1 rounded-2xl border border-white/5 bg-white/10 px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
                                        placeholder="Broadcast a message..."
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && sendChat()}
                                    />
                                    <button className="primary-btn !px-6 !py-0 !rounded-2xl" onClick={sendChat}>
                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                    </button>
                                </div>
                            </div>
                        </section>
                    </main>
                </div>

                <footer className="mt-12 pt-8 border-t border-white/5">
                    <TeamPurses
                        purses={purses}
                        title="Competitor Market Power"
                        className="bg-transparent border-none p-0"
                        maxHeightClass="max-h-[600px]"
                    />
                </footer>
            </div>

            {/* Set Transition Overlay */}
            {setTransition && (
                <div className="set-overlay">
                    <div className="set-content">
                        <div className="set-label">Next Category</div>
                        <div className="set-name">{setTransition}</div>
                    </div>
                </div>
            )}

            {/* Cinematic PASSED Overlay */}
            {passOverlay && (
                <div className="pass-overlay">
                    <div className="pass-content">
                        <div className="pass-text">PASSED</div>
                    </div>
                </div>
            )}

            {/* Cinematic WITHDRAWN Overlay */}
            {withdrawOverlay && (
                <div className="withdraw-overlay">
                    <div className="withdraw-content">
                        <div className="withdraw-text">WITHDRAWN</div>
                        <div className="withdraw-sub italic font-black">AUCTION TERMINATED FOR YOU</div>
                    </div>
                </div>
            )}

            {/* Cinematic UNSOLD Overlay */}
            {unsoldOverlay && (
                <div className="unsold-overlay">
                    <div className="unsold-content">
                        <div className="unsold-text">UNSOLD</div>
                        <div className="unsold-sub italic font-black">
                            {unsoldOverlay.playerName}
                        </div>
                    </div>
                </div>
            )}

            {/* Cinematic SOLD Overlay */}
            {soldOverlay && (
                <div className="sold-overlay">
                    <div className="sold-content text-center">
                        <div className="sold-text">SOLD</div>
                        <div className="flex flex-col items-center animate-slide-up" style={{ animationDelay: '0.2s' }}>
                            <div className="text-white text-3xl font-black uppercase italic tracking-tighter mb-2">
                                {soldOverlay.playerName}
                            </div>
                            <div className="sold-details">
                                {soldOverlay.winner} • ₹{Number(soldOverlay.price || 0).toFixed(2)} CR
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Reconnected Notification */}
            {reconnectOverlay && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
                    <div className="bg-emerald-500/10 border-2 border-emerald-500/30 backdrop-blur-xl px-12 py-6 rounded-3xl animate-slide-up flex flex-col items-center gap-2 shadow-2xl shadow-emerald-500/20">
                        <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
                        <div className="text-2xl font-black text-emerald-500 italic uppercase tracking-[0.2em]">System Reconnected</div>
                        <div className="text-[10px] font-bold text-emerald-500/60 uppercase tracking-widest italic">Synchronizing Auction State...</div>
                    </div>
                </div>
            )}

            <VoiceChat roomId={roomId} username={username} />
        </div>
    );
}
