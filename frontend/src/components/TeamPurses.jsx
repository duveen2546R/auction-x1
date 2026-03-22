export default function TeamPurses({
  purses = [],
  title = "Competitor Market Power",
  className = "",
  maxHeightClass = "max-h-[40vh]",
}) {
  return (
    <div className={`space-y-4 ${className}`.trim()}>
      <div className="flex items-center justify-between border-b border-white/5 pb-4">
        <div>
          <h4 className="text-sm font-black text-white uppercase italic tracking-widest">{title}</h4>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Real-time Franchise Financials</p>
        </div>
        <span className="text-[10px] font-black text-accent bg-accent/10 px-2 py-1 rounded border border-accent/20 uppercase tracking-widest italic">{purses.length} TEAMS</span>
      </div>

      <div className={`${maxHeightClass} overflow-y-auto pr-2 space-y-3 custom-scrollbar`.trim()}>
        {purses.map((p) => (
          <details
            key={`${p.userId}-${p.username}`}
            className="group glass-card border-white/5 bg-white/5 overflow-hidden transition-all duration-300 open:bg-white/10"
          >
            <summary className="list-none cursor-pointer p-4 select-none">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center font-black text-slate-500 italic text-lg group-open:text-accent transition-colors">
                    {p.teamName?.charAt(0) || p.username?.charAt(0)}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-black text-white uppercase italic tracking-tight group-hover:text-accent transition-colors">
                      {p.teamName || p.username}
                    </span>
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                      Owner: {p.username} · {p.players?.length || 0} Drafts
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-xl font-black text-accent italic tracking-tighter">
                    ₹{Number(p.budget ?? 0).toFixed(2)} <span className="text-[10px] tracking-normal ml-0.5">CR</span>
                  </span>
                  <span className="text-[10px] text-slate-600 font-bold uppercase tracking-widest">Available Purse</span>
                </div>
              </div>
            </summary>

            <div className="border-t border-white/5 p-4 space-y-2 bg-black/20">
              {p.players?.length ? (
                p.players.map((player) => {
                  const overseas = (player.country || "").toLowerCase() !== "india";
                  return (
                    <div
                      key={`${p.userId}-${player.id}-${player.price}`}
                      className="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 px-4 py-3 transition-colors"
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-200 uppercase italic tracking-tight">{player.name}</span>
                          {overseas && <span className="text-[8px] font-black px-1 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 uppercase tracking-tighter">OS</span>}
                        </div>
                        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                          {player.role || "player"}
                        </span>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="text-sm font-black text-emerald-400 italic tracking-tighter">
                          ₹{Number(player.price ?? 0).toFixed(2)} Cr
                        </span>
                        <span className="text-[8px] text-slate-600 font-bold uppercase tracking-widest">Market Value</span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="py-8 text-center border border-dashed border-white/5 rounded-xl">
                  <p className="text-[10px] text-slate-600 font-bold uppercase tracking-widest italic">Awaiting first acquisition</p>
                </div>
              )}
            </div>
          </details>
        ))}
        {purses.length === 0 && (
          <div className="py-12 text-center italic text-slate-700 font-black uppercase tracking-[0.3em] text-xs">
            No active franchises detected
          </div>
        )}
      </div>
    </div>
  );
}

