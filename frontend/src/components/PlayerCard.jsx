export default function PlayerCard({ player }) {
    const overseas = (player.country || "").toLowerCase() !== "india";
    return (
        <div className="glass-card p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">{player.name}</h2>
                {overseas && <span className="pill small">Overseas</span>}
            </div>
            <div className="text-sm text-slate-300">Role: {player.role}</div>
            <div className="flex gap-3 text-sm">
                <span className="text-emerald-300">Bat ⭐ {player.batting_rating ?? player.rating}</span>
                <span className="text-blue-300">Bowl ⭐ {player.bowling_rating ?? player.rating}</span>
            </div>
            <div className="text-sm text-slate-300">Base Price: ₹{player.base_price} Cr</div>
        </div>
    );
}
