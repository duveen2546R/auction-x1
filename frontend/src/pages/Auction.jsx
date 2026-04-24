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
import { clearSession, getAuthToken, getStoredUserId, getStoredUsername } from "../session";

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

export default function Auction() {
    const { state } = useLocation();
    const { roomId } = useParams();
    const navigate = useNavigate();
    const username = state?.username || getStoredUsername() || "You";
    const teamName = state?.teamName || localStorage.getItem("teamName") || "";
    
    // Safety check for userId initialization
    const initialUserId = getStoredUserId();
    const [userId, setUserId] = useState(initialUserId);

    const bgSlug = useMemo(() => {
        try {
            return teamName ? slugMap[teamName.toLowerCase()] || null : null;
        } catch {
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
    const [eliminated, setEliminated] = useState(false);
    const [isSpectator, setIsSpectator] = useState(false);
    const [bidHistory, setBidHistory] = useState([]);
    const [step, setStep] = useState(0.1);
    const [budget, setBudget] = useState(120);
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
    const [skipInfo, setSkipInfo] = useState({ count: 0, total: 0 });
    const [hasVotedSkip, setHasVotedSkip] = useState(false);
    const [currentSet, setCurrentSet] = useState(null);
    const [poolSkippedOverlay, setPoolSkippedOverlay] = useState(null);
    const isInitialJoin = useRef(true);
    const countdownAudio = useRef(new Audio("/countdown.mp3"));
    const lastAuctionEventAt = useRef(Date.now());
    const lastResyncAttemptAt = useRef(0);
    const currentSetRef = useRef(null);
    const eliminatedRef = useRef(false);
    const soldOverlayRef = useRef(null);
    const unsoldOverlayRef = useRef(null);
    const hasJoinAckRef = useRef(false);
    const preserveRoomOnExitRef = useRef(false);
    const didLeaveRoomRef = useRef(false);

    const apiBase = useMemo(() => import.meta.env.VITE_API_URL || "http://localhost:5000", []);

    useEffect(() => {
        if (teamName) localStorage.setItem("teamName", teamName);
        if (userId) localStorage.setItem("userId", String(userId));
        if (roomId) localStorage.setItem("activeRoomId", roomId);
    }, [username, teamName, userId, roomId]);

    const leaveRoom = useCallback(() => {
        if (!roomId || didLeaveRoomRef.current) return;
        didLeaveRoomRef.current = true;
        socket.emit("leave_room", { roomId });
        localStorage.removeItem("activeRoomId");
    }, [roomId]);

    const moveToResult = useCallback((resultState = {}) => {
        preserveRoomOnExitRef.current = true;
        navigate("/result", { state: resultState });
    }, [navigate]);

    useEffect(() => {
        didLeaveRoomRef.current = false;
        preserveRoomOnExitRef.current = false;

        return () => {
            if (!preserveRoomOnExitRef.current && !didLeaveRoomRef.current) {
                leaveRoom();
            }
        };
    }, [leaveRoom]);

    useEffect(() => {
        currentSetRef.current = currentSet;
    }, [currentSet]);

    useEffect(() => {
        eliminatedRef.current = eliminated;
    }, [eliminated]);

    useEffect(() => {
        soldOverlayRef.current = soldOverlay;
    }, [soldOverlay]);

    useEffect(() => {
        unsoldOverlayRef.current = unsoldOverlay;
    }, [unsoldOverlay]);

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
        const countdown = countdownAudio.current;
        const joinRoom = () => {
            if (roomId) {
                socket.emit("join_room", { roomId, username, teamName, token: getAuthToken(), intent: "resume" });
            }
        };
        const markAuctionEvent = () => {
            lastAuctionEventAt.current = Date.now();
        };

        joinRoom();

        socket.on("connect", joinRoom);

        socket.on("new_player", (player) => {
            if (!player) return;
            markAuctionEvent();
            setHasPassed(false);
            countdown.pause();
            countdown.currentTime = 0;
            setCurrentPlayer(player);
            if (player.setName && player.setName !== currentSetRef.current) {
                setCurrentSet(player.setName);
                setHasVotedSkip(false);
            }
            setCurrentBid(Number(player.base_price || 0));
            setLastBidder(null);
            setWarning(null);
            setTimeLeft({ percent: 100, ms: 13000 });
            const base = Number(player.base_price || 0);
            setStep(base < 12 ? 0.1 : base < 20 ? 0.25 : 0.5);
        });

        socket.on("bid_update", (payload) => {
            if (!payload) return;
            markAuctionEvent();
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
            markAuctionEvent();
            countdown.pause();
            countdown.currentTime = 0;
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
            if (eliminatedRef.current) setEliminated(true);
            setBidHistory([]);
            refreshPlayerStatus();
            refreshPurses();
        });

        socket.on("set_transition", (payload) => {
            if (payload?.setName) {
                markAuctionEvent();
                setSetTransition(payload.setName);
                setTimeout(() => setSetTransition(null), 4000);
            }
        });

        socket.on("auction_complete", (payload) => {
            markAuctionEvent();
            setTeam(currentTeam => {
                moveToResult({
                    roomId,
                    team: currentTeam,
                    disqualified: Array.isArray(payload?.disqualified) ? payload.disqualified.includes(username) : false,
                    deadline: payload?.deadline || null,
                });
                return currentTeam;
            });
        });

        socket.on("bid_warning", (payload) => {
            if (!payload) return;
            markAuctionEvent();
            const bidderLabel = payload.by || "current bid";
            if (payload.stage === "once") setWarning(`Going once for ${bidderLabel}...`);
            if (payload.stage === "twice") setWarning(`Going twice for ${bidderLabel}...`);
        });

        socket.on("chat_message", (msg) => {
            if (msg) setChat((c) => [...c.slice(-50), msg]);
        });

        socket.on("timer_tick", (data) => {
            if (data) {
                markAuctionEvent();
                setTimeLeft({ percent: data.percent, ms: data.remainingMs });
                
                // Play countdown for last 5 seconds
                if (data.remainingMs <= 5000 && data.remainingMs > 0) {
                    if (countdownAudio.current.paused) {
                        countdownAudio.current.currentTime = 0;
                        countdownAudio.current.play().catch(e => console.warn("Audio play blocked", e));
                    }
                } else {
                    // Stop audio if bid increases timer or reaches 0
                    countdown.pause();
                    countdown.currentTime = 0;
                }
            }
        });

        socket.on("budget_update", (b) => {
            if (typeof b?.budget === "number") {
                markAuctionEvent();
                setBudget(Number(b.budget));
            }
        });

        socket.on("purses_update", (payload) => {
            markAuctionEvent();
            const nextPurses = Array.isArray(payload?.purses) ? payload.purses : [];
            setPurses(nextPurses);
            const ownPurse = nextPurses.find((entry) => Number(entry.userId) === Number(userId));
            if (ownPurse && typeof ownPurse.budget !== "undefined") {
                setBudget(Number(ownPurse.budget));
            }
        });

        socket.on("queue_update", (q) => {
            if (q) {
                markAuctionEvent();
                setQueueInfo(q);
            }
        });

        socket.on("join_error", (payload) => {
            if (payload?.code?.startsWith("AUTH_")) {
                clearSession();
                navigate("/auth");
                return;
            }

            if (
                payload?.reason?.includes("Auction has already started") &&
                hasJoinAckRef.current
            ) {
                refreshPlayerStatus();
                refreshPurses();
                return;
            }

            localStorage.removeItem("activeRoomId");
            alert(payload.reason);
            navigate("/");
        });

        socket.on("room_closed", (payload) => {
            localStorage.removeItem("activeRoomId");
            alert(payload?.reason || "This room was closed.");
            navigate("/");
        });

        socket.on("skip_update", (data) => {
            if (data) {
                markAuctionEvent();
                setSkipInfo(data);
                if (data.setName && data.setName !== currentSetRef.current) {
                    setCurrentSet(data.setName);
                    setHasVotedSkip(false);
                }
            }
        });

        socket.on("pool_skipped", (payload) => {
            if (payload?.setName) {
                markAuctionEvent();
                // If we just sold/unsold someone, wait for that overlay to finish mostly
                const delay = (soldOverlayRef.current || unsoldOverlayRef.current) ? 2000 : 0;
                setTimeout(() => {
                    setPoolSkippedOverlay(payload.setName);
                    // Clear current bid/bidder so old values don't show during transition
                    setLastBidder(null);
                    setCurrentBid(0);
                    setWarning(null);
                    setTimeout(() => setPoolSkippedOverlay(null), 3500);
                }, delay);
            }
        });

        socket.on("join_ack", (payload) => {
            if (!payload) return;
            markAuctionEvent();
            hasJoinAckRef.current = true;
            
            if (!isInitialJoin.current) {
                setReconnectOverlay(true);
                setTimeout(() => setReconnectOverlay(false), 3000);
            }
            isInitialJoin.current = false;

            if (payload.userId) setUserId(payload.userId);
            if (Array.isArray(payload.team)) setTeam(payload.team);
            if (typeof payload.budget === "number") setBudget(Number(payload.budget));
            if (payload.queue) {
                setQueueInfo(payload.queue);
                if (payload.queue.currentSetName) setCurrentSet(payload.queue.currentSetName);
            }
            if (Array.isArray(payload.bidHistory)) setBidHistory(payload.bidHistory);
            if (typeof payload.isSpectator === "boolean") setIsSpectator(payload.isSpectator);
            if (typeof payload.hasPassed === "boolean") setHasPassed(payload.hasPassed);
            if (typeof payload.hasVotedSkip === "boolean") setHasVotedSkip(payload.hasVotedSkip);
            
            if (payload.isWithdrawn) {
                setEliminated(true);
            }

            if (payload.roomStatus === "picking" || payload.roomStatus === "finished_finalized") {
                moveToResult({
                    roomId,
                    team: payload.team || [],
                    disqualified: Array.isArray(payload?.disqualified) ? payload.disqualified.includes(username) : false,
                    deadline: payload?.deadline || null,
                    selectionStartTime: payload?.selectionStartTime || null,
                    results: payload?.results || null,
                    winner: payload?.winner || null,
                });
                return;
            }

            if (payload.currentPlayer) {
                const player = payload.currentPlayer;
                setCurrentPlayer(player);
                const bid = typeof payload.currentBid === "number" ? payload.currentBid : Number(player.base_price || 0);
                setCurrentBid(bid);
                setLastBidder(payload.lastBidder || null);
                setWarning(null);
                if (payload.timer) {
                    setTimeLeft({ percent: payload.timer.percent, ms: payload.timer.remainingMs });
                } else {
                    setTimeLeft({ percent: 100, ms: 13000 });
                }
            }
        });

        refreshPlayerStatus();
        refreshPurses();
        const poll = setInterval(() => {
            refreshPlayerStatus();
            refreshPurses();
        }, 8000);

        return () => {
            countdown.pause();
            socket.off("connect", joinRoom);
            socket.off("new_player");
            socket.off("bid_update");
            socket.off("player_won");
            socket.off("set_transition");
            socket.off("auction_complete");
            socket.off("bid_warning");
            socket.off("chat_message");
            socket.off("timer_tick");
            socket.off("budget_update");
            socket.off("purses_update");
            socket.off("queue_update");
            socket.off("join_error");
            socket.off("room_closed");
            socket.off("skip_update");
            socket.off("pool_skipped");
            socket.off("join_ack");
            clearInterval(poll);
        };
    }, [moveToResult, navigate, roomId, username, teamName, refreshPlayerStatus, refreshPurses, userId]);

    useEffect(() => {
        if (!roomId || !currentPlayer) return;

        const stallWatch = setInterval(() => {
            const now = Date.now();
            const overlayActive = Boolean(soldOverlay || unsoldOverlay || setTransition || poolSkippedOverlay);

            if (overlayActive || !socket.connected) {
                return;
            }

            if (now - lastAuctionEventAt.current < 9000) {
                return;
            }

            if (now - lastResyncAttemptAt.current < 10000) {
                return;
            }

            lastResyncAttemptAt.current = now;
            socket.emit("join_room", { roomId, username, teamName, token: getAuthToken(), intent: "resume" });
        }, 4000);

        return () => clearInterval(stallWatch);
    }, [roomId, username, teamName, currentPlayer, soldOverlay, unsoldOverlay, setTransition, poolSkippedOverlay]);

    const placeBid = (amount) => {
        if (eliminated || isSpectator || hasVotedSkip) return;
        socket.emit("place_bid", amount);
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
        if (hasPassed || hasVotedSkip || isSpectator) return;
        setHasPassed(true);
        setPassOverlay(true);
        socket.emit("pass_player");
        setTimeout(() => setPassOverlay(false), 1500);
    };

    const skipPool = () => {
        if (isSpectator || hasVotedSkip) return;
        const confirmed = window.confirm("Are you sure you want to skip the ENTIRE current pool? Once you vote skip, you cannot bid on any players in this set, and the skip will take effect after the current player is finalized.");
        if (!confirmed) return;
        
        setHasVotedSkip(true);
        // Also automatically pass on current player when skipping pool
        setHasPassed(true);
        setPassOverlay(true);
        setTimeout(() => setPassOverlay(false), 1500);
        
        socket.emit("skip_pool");
    };

    const sendChat = () => {
        const text = chatInput.trim();
        if (!text) return;
        socket.emit("chat_message", { roomId, text });
        setChatInput("");
    };

    useEffect(() => {
        const handleKeyDown = (e) => {
            // Don't trigger shortcuts if user is typing in an input or textarea
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

            const key = e.key.toUpperCase();
            if (key === "B") {
                const suggested = !!lastBidder ? (Number(currentBid) + Number(step)) : Number(currentBid);
                placeBid(suggested);
            } else if (key === "P") {
                passPlayer();
            } else if (key === "S") {
                skipPool();
            } else if (key === "W") {
                withdraw();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [currentBid, step, lastBidder, budget, eliminated, isSpectator, hasVotedSkip, hasPassed, placeBid, passPlayer, skipPool, withdraw]);

    const currentIdx = Number(queueInfo.currentIndex ?? 0);
    const totalCount = Number(queueInfo.total ?? 0);
    const bidLeaderLength = String(lastBidder || "").trim().length;
    const bidLeaderTextClass =
        bidLeaderLength > 32
            ? "text-[1.1rem] sm:text-[1.35rem] md:text-[1.75rem]"
            : bidLeaderLength > 24
                ? "text-[1.35rem] sm:text-[1.75rem] md:text-[2.1rem]"
                : bidLeaderLength > 16
                    ? "text-[1.75rem] sm:text-[2.15rem] md:text-[2.7rem]"
                    : "text-2xl sm:text-4xl md:text-5xl";

    return (
        <div
            className="min-h-screen text-slate-100 px-4 py-6 md:py-8"
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
            <div className="max-w-7xl mx-auto space-y-6 md:space-y-8">
                {isSpectator && (
                    <div className="bg-slate-500/10 border border-slate-500/20 p-3 md:p-4 rounded-2xl flex items-center justify-between animate-pulse">
                        <div className="flex items-center gap-2 md:gap-3">
                            <div className="w-2 h-2 rounded-full bg-slate-500"></div>
                            <span className="text-[9px] md:text-[10px] font-black uppercase tracking-[0.2em] md:tracking-[0.3em] text-slate-400 italic">Spectator Mode Active</span>
                        </div>
                        <span className="text-[8px] md:text-[9px] font-bold text-slate-500 uppercase tracking-widest">You joined after the auction started</span>
                    </div>
                )}
                {/* Header Section */}
                <header className="flex flex-col md:flex-row items-center justify-between gap-4 md:gap-6 pb-6 md:pb-8 border-b border-white/5">
                    <div className="flex flex-col sm:flex-row items-center gap-4 md:gap-6 w-full md:w-auto">
                        {!sidebarOpen && (
                            <button className="primary-btn !px-4 !py-2.5 !rounded-xl text-[9px] md:text-[10px] font-black tracking-widest uppercase flex items-center gap-2 shadow-accent/20 w-full sm:w-auto justify-center" onClick={() => setSidebarOpen(true)}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
                                Show Panel
                            </button>
                        )}
                        <div className="text-center md:text-left">
                            <h1 className="text-[10px] md:text-sm font-black text-accent tracking-[0.3em] uppercase mb-1">Live Auction Session</h1>
                            <div className="flex items-center justify-center md:justify-start gap-3">
                                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
                                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white uppercase italic">
                                    {roomId || "ROOM"} <span className="text-slate-500">POOL</span>
                                </h2>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-center md:justify-end gap-6 md:gap-8 w-full md:w-auto">
                        <div className="flex flex-col items-center md:items-end">
                            <span className="text-[9px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Progress</span>
                            <span className="text-base md:text-lg font-black text-white italic">{currentIdx} <span className="text-[10px] md:text-xs text-slate-500 font-medium tracking-normal not-italic">/ {totalCount} Players</span></span>
                        </div>
                        <div className="h-8 md:h-10 w-px bg-white/10"></div>
                        <div className="flex flex-col items-center md:items-end">
                            <span className="text-[9px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Current Set</span>
                            <span className="text-xs md:text-sm font-black text-white italic tracking-wide uppercase">{currentPlayer?.setName || "—"}</span>
                        </div>
                    </div>
                </header>

                <div className={`grid gap-6 md:gap-8 transition-all duration-500 ${sidebarOpen ? "lg:grid-cols-[340px_1fr] xl:grid-cols-[380px_1fr]" : "lg:grid-cols-1"}`}>
                    {sidebarOpen && (
                        <aside className="space-y-6 animate-slide-up order-2 lg:order-1">
                            <div className="flex items-center justify-between bg-white/5 p-4 rounded-2xl border border-white/5">
                                <span className="text-[10px] md:text-xs font-black uppercase tracking-widest italic text-white">Squad Profile</span>
                                <button 
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-rose-500/10 text-[9px] md:text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-rose-500 border border-white/5 hover:border-rose-500/20 transition-all duration-300 group" 
                                    onClick={() => setSidebarOpen(false)}
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-50 group-hover:opacity-100 transition-opacity">
                                        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
                                    Hide
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

                    <main className="space-y-6 md:space-y-8 order-1 lg:order-2">
                        {/* Current Player Card */}
                        <section className="space-y-4">
                            {currentPlayer ? (
                                <>
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="bg-accent/10 text-accent text-[9px] md:text-[10px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-lg border border-accent/20">
                                            Current Set: {currentPlayer.setName}
                                        </span>
                                    </div>
                                    <PlayerCard player={currentPlayer} />
                                </>
                            ) : (
                                <div className="glass-card p-12 md:p-20 flex flex-col justify-center items-center gap-4 animate-pulse">
                                    <div className="w-10 md:w-12 h-10 md:h-12 border-4 border-accent/20 border-t-accent rounded-full animate-spin"></div>
                                    <div className="italic text-slate-500 font-bold tracking-widest uppercase text-center text-[10px] md:text-xs px-4">
                                        {queueInfo.completed != null || queueInfo.remaining != null 
                                            ? "Synchronizing Live Auction State..." 
                                            : "Awaiting Next Player Selection..."}
                                    </div>
                                </div>
                            )}
                        </section>

                        {/* Bid Controls */}
                        <section className="glass-card p-6 md:p-8 space-y-6 md:space-y-8 relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-8 text-6xl md:text-[100px] font-black italic text-white/5 select-none pointer-events-none uppercase tracking-tighter">
                                BIDDING
                            </div>

                            <div className="relative z-10 flex flex-col md:flex-row justify-between items-end gap-6 md:gap-8">
                                <div className="space-y-4 w-full md:w-auto">
                                    <div className="flex flex-col">
                                        <span className="text-[9px] md:text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2">Current Bid Leader</span>
                                        <div className="flex items-center h-[70px] sm:h-[92px] md:h-[116px] w-full md:w-[28rem] lg:w-[34rem] md:max-w-[34rem] overflow-hidden bg-white/5 rounded-2xl px-4 md:px-0 md:bg-transparent">
                                            <h3 className={`${bidLeaderTextClass} font-black text-white italic uppercase tracking-tight leading-[0.9] break-words w-full max-w-full`}>
                                                {lastBidder || <span className="text-slate-700">NO BIDS</span>}
                                            </h3>
                                        </div>
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-[9px] md:text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2">Current Valuation</span>
                                        <span className="text-4xl md:text-5xl font-black text-accent italic tracking-tighter tabular-nums">
                                            ₹{Number(currentBid || 0).toFixed(2)} <span className="text-base md:text-lg">Cr</span>
                                        </span>
                                    </div>
                                </div>
                                
                                <div className="w-full md:w-auto">
                                    <div className="h-8 md:h-10 mb-4">
                                        {warning && (
                                            <div className="px-4 py-2 bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[10px] md:text-xs font-black uppercase tracking-widest italic animate-pulse">
                                                {warning}
                                            </div>
                                        )}
                                    </div>
                                    <div className="mb-6">
                                        <Timer percent={timeLeft.percent} ms={timeLeft.ms} />
                                    </div>
                                    <div className="flex flex-col gap-4">
                                        <BidPanel
                                            currentBid={currentBid}
                                            step={step}
                                            budget={budget}
                                            onBid={placeBid}
                                            onWithdraw={withdraw}
                                            onPass={passPlayer}
                                            isPassed={hasPassed || hasVotedSkip}
                                            isEliminated={eliminated}
                                            isSpectator={isSpectator}
                                            hasBidder={!!lastBidder}
                                        />
                                        <div className="px-2 md:px-4">
                                            <button 
                                                className={`w-full py-3 rounded-2xl border border-white/5 bg-white/5 hover:bg-rose-500/10 hover:border-rose-500/20 text-[9px] md:text-[10px] font-black uppercase tracking-[0.15em] md:tracking-[0.2em] transition-all duration-300 flex items-center justify-center gap-2 md:gap-3
                                                    ${(isSpectator || hasVotedSkip) ? "opacity-30 cursor-not-allowed" : ""}`}
                                                onClick={skipPool}
                                                disabled={isSpectator || hasVotedSkip}
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg>
                                                {hasVotedSkip ? "SKIP VOTE RECORDED" : "Skip Current Pool"} {skipInfo.total > 0 && `(${skipInfo.count}/${skipInfo.total})`}
                                            </button>
                                            <p className="text-[8px] md:text-[9px] text-slate-500 text-center mt-2 font-bold uppercase tracking-widest italic px-2">
                                                * All participants must vote to skip the entire set
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Bid History & Chat */}
                        <section className="grid md:grid-cols-2 gap-6 md:gap-8">
                            <div className="glass-card p-5 md:p-6 flex flex-col h-[350px] md:h-[400px]">
                                <div className="flex items-center justify-between mb-4 md:mb-6">
                                    <span className="text-[10px] md:text-xs font-black uppercase tracking-widest italic text-white">Live Bidding History</span>
                                    <span className="w-1.5 md:w-2 h-1.5 md:h-2 rounded-full bg-emerald-500"></span>
                                </div>
                                <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
                                    {Array.isArray(bidHistory) && bidHistory.length === 0 && (
                                        <div className="h-full flex flex-col items-center justify-center text-slate-600 italic text-[10px] md:text-xs">
                                            Awaiting first bid...
                                        </div>
                                    )}
                                    {Array.isArray(bidHistory) && bidHistory.slice().reverse().map((h, i) => (
                                        <div key={i} className="flex justify-between items-center bg-white/5 border border-white/5 p-2.5 md:p-3 rounded-xl hover:bg-white/10 transition">
                                            <div className="flex flex-col">
                                                <span className="text-white font-bold text-xs md:text-sm uppercase italic tracking-tight truncate max-w-[120px] sm:max-w-none">
                                                    {h.by || "—"}
                                                </span>
                                                <span className="text-[9px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest">{h.note || "BID"}</span>
                                            </div>
                                            <span className="text-base md:text-lg font-black text-accent italic tracking-tighter tabular-nums">₹{h.amount} Cr</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="glass-card p-5 md:p-6 flex flex-col h-[350px] md:h-[400px]">
                                <div className="flex items-center justify-between mb-4 md:mb-6">
                                    <span className="text-[10px] md:text-xs font-black uppercase tracking-widest italic text-white">War Room Chat</span>
                                    <span className="text-[9px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest">LIVE</span>
                                </div>
                                <div className="flex-1 overflow-y-auto pr-2 space-y-4 mb-4 md:mb-6 custom-scrollbar">
                                    {Array.isArray(chat) && chat.map((m, i) => (
                                        <div key={i} className="flex flex-col gap-1">
                                            <span className="text-[9px] md:text-[10px] font-black uppercase tracking-widest text-accent italic">{m.user}</span>
                                            <div className="bg-white/5 p-2.5 md:p-3 rounded-2xl rounded-tl-none border border-white/5 text-slate-200 text-xs md:text-sm leading-relaxed">
                                                {m.text}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex gap-2 text-night">
                                    <input
                                        className="flex-1 rounded-2xl border border-white/5 bg-white/10 px-4 py-2.5 md:py-3 text-xs md:text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
                                        placeholder="Broadcast..."
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && sendChat()}
                                    />
                                    <button className="primary-btn !px-4 md:!px-6 !py-0 !rounded-2xl" onClick={sendChat}>
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                    </button>
                                </div>
                            </div>
                        </section>
                    </main>
                </div>

                <footer className="mt-8 md:mt-12 pt-6 md:pt-8 border-t border-white/5">
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
                    <div className="set-content px-4 text-center">
                        <div className="set-label">Next Category</div>
                        <div className="set-name !text-4xl sm:!text-6xl md:!text-8xl">{setTransition}</div>
                    </div>
                </div>
            )}

            {/* Cinematic PASSED Overlay */}
            {passOverlay && (
                <div className="pass-overlay">
                    <div className="pass-content">
                        <div className="pass-text !text-6xl sm:!text-8xl">PASSED</div>
                    </div>
                </div>
            )}

            {/* Cinematic WITHDRAWN Overlay */}
            {withdrawOverlay && (
                <div className="withdraw-overlay">
                    <div className="withdraw-content px-4 text-center">
                        <div className="withdraw-text !text-5xl sm:!text-[10vw]">WITHDRAWN</div>
                        <div className="withdraw-sub italic font-black text-sm sm:text-lg">AUCTION TERMINATED FOR YOU</div>
                    </div>
                </div>
            )}

            {/* Cinematic UNSOLD Overlay */}
            {unsoldOverlay && (
                <div className="unsold-overlay">
                    <div className="unsold-content px-4 text-center">
                        <div className="unsold-text !text-6xl sm:!text-[12vw]">UNSOLD</div>
                        <div className="unsold-sub italic font-black text-sm sm:text-2xl">
                            {unsoldOverlay.playerName}
                        </div>
                    </div>
                </div>
            )}

            {/* Cinematic SOLD Overlay */}
            {soldOverlay && (
                <div className="sold-overlay">
                    <div className="sold-content text-center px-4">
                        <div className="sold-text !text-6xl sm:!text-[12vw]">SOLD</div>
                        <div className="flex flex-col items-center animate-slide-up" style={{ animationDelay: '0.2s' }}>
                            <div className="text-white text-xl sm:text-3xl font-black uppercase italic tracking-tighter mb-2 break-words max-w-full">
                                {soldOverlay.playerName}
                            </div>
                            <div className="sold-details !text-base sm:!text-2xl !px-4 sm:!px-8 !py-2 sm:!py-3">
                                {soldOverlay.winner} • ₹{Number(soldOverlay.price || 0).toFixed(2)} CR
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Cinematic POOL SKIPPED Overlay */}
            {poolSkippedOverlay && (
                <div className="withdraw-overlay !bg-slate-900/80">
                    <div className="withdraw-content px-4 text-center">
                        <div className="withdraw-text !text-4xl sm:!text-[10vw] !text-slate-400">POOL SKIPPED</div>
                        <div className="withdraw-sub !bg-slate-700 italic font-black uppercase text-xs sm:text-lg">{poolSkippedOverlay}</div>
                    </div>
                </div>
            )}

            {/* Reconnected Notification */}
            {reconnectOverlay && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none px-4">
                    <div className="bg-emerald-500/10 border-2 border-emerald-500/30 backdrop-blur-xl px-6 md:px-12 py-4 md:py-6 rounded-3xl animate-slide-up flex flex-col items-center gap-2 shadow-2xl shadow-emerald-500/20 text-center">
                        <div className="w-2 md:w-3 h-2 md:h-3 rounded-full bg-emerald-500 animate-pulse"></div>
                        <div className="text-xl md:text-2xl font-black text-emerald-500 italic uppercase tracking-[0.1em] md:tracking-[0.2em]">System Reconnected</div>
                        <div className="text-[8px] md:text-[10px] font-bold text-emerald-500/60 uppercase tracking-widest italic">Synchronizing Auction State...</div>
                    </div>
                </div>
            )}

            <VoiceChat roomId={roomId} username={username} />
        </div>
    );
}
