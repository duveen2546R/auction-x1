export default function TeamList({ team, budget = 100 }) {
    const totalRating = team.reduce((sum, player) => sum + Number(player.rating || 0), 0);
    const spent = Math.max(0, 100 - Number(budget || 0));
    const groups = {
        batsman: [],
        bowler: [],
        allrounder: [],
        wicketkeeper: [],
    };
    team.forEach((p) => {
        const role = (p.role || "").toLowerCase();
        if (role.includes("all")) groups.allrounder.push(p);
        else if (role.includes("keep")) groups.wicketkeeper.push(p);
        else if (role.includes("bowl")) groups.bowler.push(p);
        else groups.batsman.push(p);
    });

    const renderGroup = (title, list) => (
        <div key={title} className="mt-2">
            <h4 className="text-sm uppercase tracking-wide text-slate-400">{title}</h4>
            {list.length === 0 && <p className="text-xs text-slate-500">None</p>}
            {list.map((p, i) => {
                const overseas = (p.country || "").toLowerCase() !== "india";
                return (
                    <div key={`${p.id}-${i}`} className="flex justify-between items-center border-b border-border/70 py-2 text-sm">
                        <span className="flex items-center gap-2">
                            {p.name} {overseas && <span className="pill tiny">OS</span>}
                        </span>
                        <span className="text-slate-400">
                            Bat ⭐ {p.batting_rating ?? p.rating} · Bowl ⭐ {p.bowling_rating ?? p.rating}
                        </span>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold">Your Team · Rating {totalRating}</h3>
            <p className="text-sm text-slate-300">Purse: ₹{Number(budget || 0).toFixed(2)} Cr · Spent: ₹{spent.toFixed(2)} Cr</p>
            {team.length === 0 && <p className="text-slate-400 text-sm">No players yet</p>}
            {renderGroup("Batsmen", groups.batsman)}
            {renderGroup("All-rounders", groups.allrounder)}
            {renderGroup("Bowlers", groups.bowler)}
            {renderGroup("Wicketkeepers", groups.wicketkeeper)}
        </div>
    );
}
