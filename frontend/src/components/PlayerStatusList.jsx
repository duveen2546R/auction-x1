import { useMemo, useState } from "react";

const roleLabel = {
  batsman: "Batsman",
  bowler: "Bowler",
  allrounder: "All-rounder",
  wicketkeeper: "Wicketkeeper",
};

const roleOrder = { batsman: 0, allrounder: 1, bowler: 2, wicketkeeper: 3 };

export default function PlayerStatusList({ sold = [], remaining = [], unsold = [], currentId = null }) {
  const [filter, setFilter] = useState("all"); // available | sold | unsold | all

  const sections = useMemo(() => {
    const available = remaining
      .map((p) => ({ ...p, status: "Available" }))
      .sort((a, b) => {
        const ra = roleOrder[(a.role || "").toLowerCase()] ?? 99;
        const rb = roleOrder[(b.role || "").toLowerCase()] ?? 99;
        if (ra !== rb) return ra - rb;
        return (a.name || "").localeCompare(b.name || "");
      });

    const soldList = sold
      .map((p) => ({ ...p, status: "Sold" }))
      .sort((a, b) => {
        const ra = roleOrder[(a.role || "").toLowerCase()] ?? 99;
        const rb = roleOrder[(b.role || "").toLowerCase()] ?? 99;
        if (ra !== rb) return ra - rb;
        return (a.name || "").localeCompare(b.name || "");
      });

    const unsoldList = unsold
      .map((p) => ({ ...p, status: "Unsold" }))
      .sort((a, b) => {
        const ra = roleOrder[(a.role || "").toLowerCase()] ?? 99;
        const rb = roleOrder[(b.role || "").toLowerCase()] ?? 99;
        if (ra !== rb) return ra - rb;
        return (a.name || "").localeCompare(b.name || "");
      });

    if (filter === "available") return [{ title: "Available", items: available }];
    if (filter === "sold") return [{ title: "Sold", items: soldList }];
    if (filter === "unsold") return [{ title: "Unsold", items: unsoldList }];
    return [
      { title: "Available", items: available },
      { title: "Sold", items: soldList },
      { title: "Unsold", items: unsoldList },
    ];
  }, [filter, remaining, sold, unsold]);

  const badge = (status) =>
    status === "Sold"
      ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/60"
      : status === "Unsold"
      ? "bg-rose-500/20 text-rose-200 border border-rose-500/60"
      : "bg-sky-500/15 text-sky-100 border border-sky-500/40";

  const rowBg = (status) =>
    status === "Sold" ? "bg-emerald-500/10" : status === "Unsold" ? "bg-rose-500/10" : "bg-slate-900/70";

  const btn = (key, label, count) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      className={`px-3 py-1 rounded-full text-xs border transition ${
        filter === key
          ? "bg-slate-100 text-night border-slate-100"
          : "border-border text-slate-200 hover:bg-card"
      }`}
    >
      {label} {typeof count === "number" ? `(${count})` : ""}
    </button>
  );

  return (
    <div className="space-y-2 bg-[#0a0f1c]/90 border border-border rounded-xl p-3 backdrop-blur">
      <div className="flex items-center justify-between text-slate-100">
        <h4 className="text-sm uppercase tracking-wide">All Players</h4>
        <span className="text-[11px] text-slate-300">Sold {sold.length} · Unsold {unsold.length} · Remaining {remaining.length}</span>
      </div>

      <div className="flex gap-2 text-xs flex-wrap">{
        [
          ["available", "Available", remaining.length],
          ["sold", "Sold", sold.length],
          ["unsold", "Unsold", unsold.length],
          ["all", "All", sold.length + unsold.length + remaining.length],
        ].map(([k, label, count]) => btn(k, label, count))
      }</div>

      <div className="max-h-[58vh] overflow-y-auto pr-1 space-y-2">
        {sections.map(({ title, items }) => (
          <div key={title} className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-slate-400 sticky top-0 bg-[#0a0f1c]/95 py-1">
              {title} ({items.length})
            </div>
            {items.map((p) => {
              const role = (p.role || "").toLowerCase();
              const overseas = (p.country || "").toLowerCase() !== "india";
              const isCurrent = currentId === p.id;
              return (
                <div
                  key={`${p.id}-${p.status}`}
                  className={`flex items-start justify-between rounded-lg px-3 py-2 border border-border ${rowBg(p.status)} ${
                    isCurrent ? "ring-2 ring-accent" : ""
                  }`}
                >
                  <div className="space-y-0.5 text-slate-100">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span>{p.name}</span>
                      {overseas && <span className="pill tiny">OS</span>}
                      {isCurrent && <span className="pill tiny bg-accent text-slate-900">Current</span>}
                    </div>
                    <div className="text-[11px] text-slate-300 flex gap-2 flex-wrap">
                      <span>{roleLabel[role] || "Player"}</span>
                      <span>Bat ⭐ {p.batting_rating ?? p.rating ?? "-"}</span>
                      <span>Bowl ⭐ {p.bowling_rating ?? p.rating ?? "-"}</span>
                    </div>
                  </div>
                  <span className={`text-[11px] px-2 py-1 rounded-full whitespace-nowrap ${badge(p.status)}`}>
                    {p.status === "Sold" ? (p.soldTo || "Sold") : p.status}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {sections.every((s) => s.items.length === 0) && <p className="text-xs text-slate-400">No players loaded</p>}
      </div>
    </div>
  );
}
