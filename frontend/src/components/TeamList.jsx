export default function TeamList({ team, budget = 120 }) {
    const totalRating = team.reduce((sum, player) => sum + Number(player.rating || 0), 0);
    const groups = {
        batsman: [],
        bowler: [],
        allrounder: [],
        wicketkeeper: [],
    };
    
    team.forEach((p) => {
        const role = (p.role || "").toLowerCase();
        if (role.includes("all")) groups.allrounder.push(p);
        else if (role.includes("keep") || role.includes("wk")) groups.wicketkeeper.push(p);
        else if (role.includes("bowl") || role.includes("pace") || role.includes("spin")) groups.bowler.push(p);
        else groups.batsman.push(p);
    });

    const renderGroup = (label, list) => {
        if (list.length === 0) return null;
        return (
            <div key={label} className="space-y-2">
                <div className="flex items-center gap-2">
                    <span className="h-px flex-1 bg-white/5"></span>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 italic">{label}</span>
                    <span className="h-px flex-1 bg-white/5"></span>
                </div>
                {list.map((p, i) => {
                    const overseas = (p.country || "").toLowerCase() !== "india";
                    return (
                        <div key={`${p.id}-${i}`} className="flex justify-between items-center group/item hover:bg-white/5 p-2 rounded-xl transition-all">
                            <div className="flex flex-col">
                                <span className="text-sm font-bold text-white tracking-tight flex items-center gap-2 italic">
                                    {p.name}
                                    {overseas && <span className="pill tiny border-none bg-accent/20 text-accent">OS</span>}
                                </span>
                                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                    {p.role}
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex flex-col items-end">
                                    <span className="text-sm font-black text-accent italic tracking-tighter">₹{Number(p.price || 0).toFixed(2)} Cr</span>
                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Price</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="space-y-6">
            <div className="stat-card !items-start !p-5 relative overflow-hidden bg-accent/5 border-accent/10">
                <div className="relative z-10 flex flex-col gap-1">
                    <span className="text-[10px] text-accent font-black uppercase tracking-[0.2em] italic">Squad Valuation</span>
                    <span className="text-3xl font-black text-white italic tracking-tighter">₹{Number(budget || 0).toFixed(2)} <span className="text-sm">Cr Left</span></span>
                    <div className="mt-2 flex items-center gap-4">
                        <div className="flex flex-col">
                            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Squad Size</span>
                            <span className="text-sm font-black text-white italic tracking-widest">{team.length} / 11</span>
                        </div>
                    </div>
                </div>
                <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none uppercase font-black italic text-4xl">
                    FINANCE
                </div>
            </div>

            <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {team.length === 0 && (
                    <div className="flex flex-col items-center justify-center p-8 border border-dashed border-white/5 rounded-3xl opacity-40">
                        <span className="text-xs font-black uppercase tracking-widest italic">No Players Acquired</span>
                    </div>
                )}
                {renderGroup("Top Order / Batsmen", groups.batsman)}
                {renderGroup("All Rounders", groups.allrounder)}
                {renderGroup("Strike Force / Bowlers", groups.bowler)}
                {renderGroup("Wicket Keepers", groups.wicketkeeper)}
            </div>
        </div>
    );
}
