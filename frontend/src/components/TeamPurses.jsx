export default function TeamPurses({
  purses = [],
  title = "Team Purses",
  className = "",
  maxHeightClass = "max-h-[40vh]",
}) {
  return (
    <div className={`space-y-2 bg-[#0a0f1c]/90 border border-border rounded-xl p-3 ${className}`.trim()}>
      <div className="flex items-center justify-between text-slate-100">
        <h4 className="text-sm uppercase tracking-wide">{title}</h4>
        <span className="text-[11px] text-slate-300">{purses.length} teams</span>
      </div>
      <div className={`${maxHeightClass} overflow-y-auto pr-1 space-y-1`.trim()}>
        {purses.map((p) => (
          <details
            key={`${p.userId}-${p.username}`}
            className="rounded-lg border border-border bg-slate-900/70 open:bg-slate-900"
          >
            <summary className="list-none cursor-pointer px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-slate-100">{p.teamName || p.username}</span>
                  <span className="text-[11px] text-slate-400">
                    Owner: {p.username} · Players: {p.players?.length || 0}
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-sm font-semibold text-accent">
                    ₹{Number(p.budget ?? 0).toFixed(2)} Cr
                  </span>
                  <span className="text-[11px] text-slate-400">Purse balance</span>
                </div>
              </div>
            </summary>

            <div className="border-t border-border px-3 py-2 space-y-2">
              {p.players?.length ? (
                p.players.map((player) => (
                  <div
                    key={`${p.userId}-${player.id}-${player.price}`}
                    className="flex items-center justify-between rounded-md border border-border/60 bg-[#0f1628] px-3 py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm text-slate-100">{player.name}</span>
                      <span className="text-[11px] text-slate-400 capitalize">
                        {player.role || "player"} · {(player.country || "").toLowerCase() !== "india" ? "Overseas" : "Indian"}
                      </span>
                    </div>
                    <span className="text-sm font-medium text-emerald-300">
                      ₹{Number(player.price ?? 0).toFixed(2)} Cr
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-slate-400">No players bought yet</p>
              )}
            </div>
          </details>
        ))}
        {purses.length === 0 && <p className="text-xs text-slate-400">No teams yet</p>}
      </div>
    </div>
  );
}
