import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Home() {
    const [username, setUsername] = useState(localStorage.getItem("username") || "");
    const [roomCode, setRoomCode] = useState("");
    const [teamName, setTeamName] = useState(localStorage.getItem("teamName") || "");
    const [teams, setTeams] = useState([]);
    const [players, setPlayers] = useState([]);
    const navigate = useNavigate();

    useEffect(() => {
        fetch(`${import.meta.env.VITE_API_URL || "http://localhost:5000"}/teams`)
            .then((res) => res.json())
            .then(setTeams)
            .catch(() => setTeams([]));
        fetch(`${import.meta.env.VITE_API_URL || "http://localhost:5000"}/players`)
            .then((r) => r.json())
            .then(setPlayers)
            .catch(() => setPlayers([]));
    }, []);

    const persistName = (name) => {
        setUsername(name);
        localStorage.setItem("username", name);
    };

    const persistTeam = (team) => {
        setTeamName(team);
        localStorage.setItem("teamName", team);
    };

    const createRoom = () => {
        const roomId = Math.floor(100000 + Math.random() * 900000);
        navigate(`/lobby/${roomId}`, { state: { username, teamName } });
    };

    const joinRoom = () => {
        if (!roomCode) return;
        navigate(`/lobby/${roomCode}`, { state: { username, teamName } });
    };

    const canProceed = username && teamName;

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
        <div className="glass-card border border-border p-4">
            <div className="flex justify-between text-sm text-slate-300">
                <span className="font-semibold">{title}</span>
                <span>{list.length}</span>
            </div>
            <div className="text-xs text-slate-400 space-y-1 max-h-44 overflow-y-auto">
                {list.map((p) => (
                    <div key={p.id} className="flex justify-between">
                        <span>{p.name}</span>
                        <span>
                            Bat {p.batting_rating ?? p.rating} · Bowl {p.bowling_rating ?? p.rating} · {(p.country || "").toLowerCase() !== "india" ? "OS" : "IND"}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-night text-slate-100 px-4 py-8">
            <div className="max-w-6xl mx-auto space-y-6">
                <div className="glass-card border border-border p-8 grid md:grid-cols-2 gap-8">
                    <div className="flex flex-col gap-4">
                        <span className="pill">Multiplayer · Live Bidding</span>
                        <h1 className="text-4xl font-semibold">IPL Auction Arena</h1>
                        <p className="text-slate-300">Pick your franchise, invite friends, and battle in real-time.</p>
                        <div className="grid md:grid-cols-2 gap-3">
                            <div>
                                <label className="text-sm text-slate-400">Username</label>
                                <input
                                    className="w-full mt-1 rounded-xl border border-border bg-card px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                                    placeholder="Captain name"
                                    value={username}
                                    onChange={(e) => persistName(e.target.value)}
                                />
                            </div>
                            <div>
                                <label className="text-sm text-slate-400">Team</label>
                                <select
                                    className="w-full mt-1 rounded-xl border border-border bg-card px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                                    value={teamName}
                                    onChange={(e) => persistTeam(e.target.value)}
                                >
                                    <option value="" disabled>Choose your franchise</option>
                                    {teams.map((t) => (
                                        <option key={t.id} value={t.name}>{t.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-3">
                            <button className="primary-btn w-full" onClick={createRoom} disabled={!canProceed}>Create Room</button>
                            <div className="glass-card border border-dashed border-border p-3 flex flex-col gap-2">
                                <label className="text-sm text-slate-400">Room Code</label>
                                <div className="flex gap-2">
                                    <input
                                        className="flex-1 rounded-xl border border-border bg-card px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                                        placeholder="123456"
                                        value={roomCode}
                                        onChange={(e) => setRoomCode(e.target.value)}
                                    />
                                    <button className="primary-btn" onClick={joinRoom} disabled={!canProceed || !roomCode}>Join</button>
                                </div>
                            </div>
                        </div>
                        <p className="text-xs text-slate-400">Need 3+ players. Use multiple incognito windows to test locally.</p>
                    </div>
                    <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-indigo-900/40 to-slate-900/40 shadow-glass min-h-[320px] flex items-center justify-center">
                        <div className="absolute top-4 right-4 bg-orange-400 text-slate-900 px-3 py-1 rounded-full text-sm font-semibold">Live</div>
                        <div className="relative w-64 h-64">
                            <div className="absolute inset-0 blur-3xl bg-blue-400/20 rounded-full" />
                            <div className="absolute inset-10 rounded-full border border-accent/40 rotate-6" />
                            <div className="absolute inset-16 rounded-full border border-accent2/50 -rotate-6" />
                            <div className="absolute inset-[38%] w-16 h-16 bg-gradient-to-br from-orange-400 to-pink-500 rounded-full shadow-lg animate-bounce" />
                        </div>
                    </div>
                </div>

                <div className="glass-card border border-border p-6 space-y-4">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                        <h3 className="text-2xl font-semibold">Player Pool</h3>
                        <p className="text-slate-400 text-sm">Separated by role and overseas/Indian.</p>
                    </div>
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
                        {renderList("Batsmen", grouped.batsman)}
                        {renderList("All-rounders", grouped.allrounder)}
                        {renderList("Bowlers", grouped.bowler)}
                        {renderList("Wicketkeepers", grouped.wicketkeeper)}
                    </div>
                </div>

                <div className="glass-card border border-border p-6 grid md:grid-cols-2 gap-4">
                    <div>
                        <h3 className="text-xl font-semibold mb-2">Auction Rules</h3>
                        <ul className="text-slate-300 text-sm list-disc list-inside space-y-1">
                            <li>Bid step: ₹0.10 Cr &lt; 12 Cr, ₹0.25 Cr &lt; 20 Cr, else ₹0.50 Cr.</li>
                            <li>Pass skips current player (per-player); Withdraw sells to you and blocks further bids.</li>
                            <li>Playing XI rules: ≥3 batsmen, ≥2 bowlers, ≥1 wicketkeeper, max 4 all-rounders, max 4 overseas.</li>
                            <li>2 minutes to submit XI; auto-submit or disqualify otherwise.</li>
                        </ul>
                    </div>
                    <div>
                        <h3 className="text-xl font-semibold mb-2">Quotes</h3>
                        <p className="text-slate-300 text-sm">“Auction wars are won in the margins—every bid is a story.”</p>
                        <p className="text-slate-300 text-sm mt-2">“Build balance, not just stars. Champions are crafted, not collected.”</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
