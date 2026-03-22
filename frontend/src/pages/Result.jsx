import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import socket from "../socket";

function validateLineup(team, ids) {
    const lineup = team.filter((p) => ids.includes(p.id));
    const roleCounts = { bat: 0, bowl: 0, wk: 0, ar: 0, overseas: 0 };
    let battingTotal = 0;
    let bowlingTotal = 0;

    lineup.forEach((p) => {
        const role = (p.role || "").toLowerCase();
        const isAr = role.includes("all");
        const isBat = role.includes("bat");
        const isBowl = role.includes("bowl");
        const isWk = role.includes("keep");
        const isOverseas = (p.country || "").toLowerCase() !== "india";
        if (isOverseas) roleCounts.overseas += 1;
        const batR = Number(p.batting_rating ?? p.rating ?? 0);
        const bowlR = Number(p.bowling_rating ?? p.rating ?? 0);
        if (isAr) {
            roleCounts.ar += 1;
            roleCounts.bat += 1;
            roleCounts.bowl += 1;
            battingTotal += batR;
            bowlingTotal += bowlR;
        } else {
            if (isBat) { roleCounts.bat += 1; battingTotal += batR; }
            if (isBowl) { roleCounts.bowl += 1; bowlingTotal += bowlR; }
            if (isWk) { roleCounts.wk += 1; battingTotal += batR; }
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
    const team = state?.team || [];
    const isDisqualified = state?.disqualified;
    const deadline = state?.deadline || null;
    const [selected, setSelected] = useState([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const [results, setResults] = useState(null);
    const [winner, setWinner] = useState(null);
    const [remaining, setRemaining] = useState(null);

    useEffect(() => {
        const onResults = (payload) => {
            setResults(payload.results);
            setWinner(payload.winner);
            setSubmitting(false);
        };
        const onErr = (payload) => {
            setError(payload.reason);
            setSubmitting(false);
        };
        socket.on("playing11_results", onResults);
        socket.on("playing11_error", onErr);
        socket.on("playing11_ack", () => setSubmitting(true));
        return () => {
            socket.off("playing11_results", onResults);
            socket.off("playing11_error", onErr);
            socket.off("playing11_ack");
        };
    }, []);

    useEffect(() => {
        if (team.length >= 11 && selected.length === 0) {
            setSelected(team.slice(0, 11).map((p) => p.id));
        }
    }, [team, selected.length]);

    useEffect(() => {
        if (!deadline) return;
        const tick = () => {
            const ms = deadline - Date.now();
            setRemaining(ms > 0 ? Math.ceil(ms / 1000) : 0);
        };
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [deadline]);

    const validation = useMemo(() => validateLineup(team, selected), [team, selected]);

    const toggle = (id) => {
        if (selected.includes(id)) {
            setSelected(selected.filter((x) => x !== id));
        } else {
            setSelected([...selected, id].slice(0, 11));
        }
    };

    const submit = () => {
        if (isDisqualified) return;
        setError(null);
        const v = validateLineup(team, selected);
        if (!v.ok) {
            setError(v.errors.join(", "));
            return;
        }
        setSubmitting(true);
        socket.emit("submit_playing11", { playerIds: selected });
    };

    return (
        <div className="min-h-screen bg-night text-slate-100 px-4 py-6">
            <div className="max-w-6xl mx-auto grid lg:grid-cols-[2fr_1fr] gap-4">
                <div className="glass-card border border-border p-5 space-y-4">
                    <div>
                        <h1 className="text-3xl font-semibold">Choose Your Best XI</h1>
                        <p className="text-slate-400 text-sm">
                            Rules: 11 players, ≥3 batsmen, ≥2 bowlers, ≥1 wicketkeeper, max 4 all-rounders, max 4 overseas.
                            {remaining !== null && ` · Auto-submit in ${remaining}s`}
                        </p>
                        {isDisqualified && <p className="text-amber-400 text-sm mt-2">You are disqualified (insufficient squad to meet rules).</p>}
                    </div>

                    <div className="glass-card border border-border p-3 max-h-[480px] overflow-y-auto">
                        <h3 className="font-semibold mb-2">Your squad ({team.length})</h3>
                        {team.map((p) => {
                            const checked = selected.includes(p.id);
                            const overseas = (p.country || "").toLowerCase() !== "india";
                            return (
                                <div key={p.id} className="flex justify-between items-center border-b border-border/60 py-2 text-sm">
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            className="accent-accent"
                                            checked={checked}
                                            onChange={() => toggle(p.id)}
                                        />
                                        <span>{p.name}</span>
                                        <span className="text-slate-400">[{p.role}]</span>
                                        {overseas && <span className="pill tiny">OS</span>}
                                    </label>
                                    <span className="text-slate-400">Bat ⭐ {p.batting_rating ?? p.rating} · Bowl ⭐ {p.bowling_rating ?? p.rating}</span>
                                </div>
                            );
                        })}
                    </div>

                    <div className="glass-card border border-border p-3">
                        <p className="text-sm">Selected: {selected.length}/11</p>
                        <p className="text-sm text-slate-300">Batters: {validation.roleCounts.bat} | Bowlers: {validation.roleCounts.bowl} | Keepers: {validation.roleCounts.wk} | All-rounders: {validation.roleCounts.ar} | Overseas: {validation.roleCounts.overseas}</p>
                        {!validation.ok && <p className="text-amber-400 text-sm">Fix: {validation.errors.join(", ")}</p>}
                        {error && <p className="text-amber-400 text-sm">Error: {error}</p>}
                        <button className="primary-btn mt-2" onClick={submit} disabled={!validation.ok || submitting || isDisqualified}>
                            {submitting ? "Waiting for others..." : "Submit Playing XI"}
                        </button>
                    </div>
                </div>

                <div className="glass-card border border-border p-4 space-y-3">
                    <h3 className="font-semibold">Final Scores</h3>
                    {results ? (
                        <>
                            <p className="text-lg">Winner: {winner}</p>
                            {results.map((r, idx) => (
                                <div key={idx} className="border-b border-border/60 py-2 text-sm">
                                    <div className="font-semibold">{r.username}</div>
                                    <div>Score: {r.score.toFixed(1)}</div>
                                    <div className="text-slate-400">Bat {r.breakdown.battingTotal} · Bowl {r.breakdown.bowlingTotal} · Bonus {r.breakdown.balanceBonus}</div>
                                </div>
                            ))}
                        </>
                    ) : (
                        <p className="text-slate-400 text-sm">Awaiting submissions...</p>
                    )}
                </div>
            </div>
        </div>
    );
}
