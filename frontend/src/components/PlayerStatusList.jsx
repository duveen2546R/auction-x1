import { useMemo, useState } from "react";

const roleOrder = { batsman: 0, allrounder: 1, bowler: 2, wicketkeeper: 3 };

export default function PlayerStatusList({ sold = [], remaining = [], unsold = [], currentId = null }) {
  const [filter, setFilter] = useState("all");

  const sections = useMemo(() => {
    const process = (list, status) => list.map(p => ({ ...p, status }))
      .sort((a, b) => (roleOrder[(a.role || "").toLowerCase()] ?? 99) - (roleOrder[(b.role || "").toLowerCase()] ?? 99) || (a.name || "").localeCompare(b.name || ""));

    if (filter === "available") return [{ title: "Available", items: process(remaining, "Available") }];
    if (filter === "sold") return [{ title: "Sold", items: process(sold, "Sold") }];
    if (filter === "unsold") return [{ title: "Unsold", items: process(unsold, "Unsold") }];
    
    return [
      { title: "Available", items: process(remaining, "Available") },
      { title: "Sold", items: process(sold, "Sold") },
      { title: "Unsold", items: process(unsold, "Unsold") },
    ];
  }, [filter, remaining, sold, unsold]);

  const badge = (status) =>
    status === "Sold" ? "text-emerald-500 border-emerald-500/20 bg-emerald-500/10" :
    status === "Unsold" ? "text-rose-500 border-rose-500/20 bg-rose-500/10" :
    "text-accent border-accent/20 bg-accent/10";

  const btn = (key, label, count) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all ${
        filter === key ? "bg-accent text-night border-accent italic" : "border-white/5 text-slate-500 hover:text-white hover:bg-white/5"
      }`}
    >
      {label} <span className="opacity-60 ml-1">{count}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-black uppercase tracking-widest italic text-white">Market Inventory</span>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse"></span>
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Live Updates</span>
          </div>
        </div>
        
        <div className="flex gap-2 flex-wrap">
          {btn("available", "Draft", remaining.length)}
          {btn("sold", "Sold", sold.length)}
          {btn("unsold", "Unsold", unsold.length)}
          {btn("all", "All", sold.length + unsold.length + remaining.length)}
        </div>
      </div>

      <div className="max-h-[500px] overflow-y-auto pr-2 space-y-6 custom-scrollbar">
        {sections.map(({ title, items }) => (
          items.length > 0 && (
            <div key={title} className="space-y-3">
              <div className="flex items-center gap-2 sticky top-0 bg-[#020408] z-10 py-2">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 italic">{title}</span>
                <div className="h-px flex-1 bg-white/5"></div>
              </div>
              
              <div className="grid gap-2">
                {items.map((p) => {
                  const overseas = (p.country || "").toLowerCase() !== "india";
                  const isCurrent = currentId === p.id;
                  return (
                    <div
                      key={`${p.id}-${p.status}`}
                      className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                        isCurrent ? "bg-accent/10 border-accent/30 shadow-[0_0_15px_rgba(0,245,255,0.1)]" : "bg-white/5 border-white/5 hover:bg-white/10"
                      }`}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-bold uppercase italic tracking-tight ${isCurrent ? "text-accent" : "text-slate-200"}`}>{p.name}</span>
                          {overseas && <span className="text-[8px] font-black px-1 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 uppercase tracking-tighter">OS</span>}
                        </div>
                        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{p.role}</span>
                      </div>
                      <div className={`text-[9px] font-black px-2 py-1 rounded border uppercase tracking-widest italic ${badge(p.status)}`}>
                        {p.status === "Sold" ? (p.soldTo || "SOLD") : p.status}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )
        ))}
        {sections.every(s => s.items.length === 0) && (
          <div className="py-12 text-center border border-dashed border-white/5 rounded-2xl opacity-40">
            <span className="text-xs font-black uppercase tracking-widest italic">Inventory Depleted</span>
          </div>
        )}
      </div>
    </div>
  );
}

