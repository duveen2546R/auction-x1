export default function PlayerCard({ player }) {
    const isOverseas = (player.country || "").toLowerCase() !== "india";
    const role = (player.role || "").toLowerCase();
    
    const roleColor = role.includes("bat") ? "text-emerald-400" : 
                    role.includes("bowl") ? "text-blue-400" : 
                    role.includes("keep") ? "text-amber-400" : "text-purple-400";

    return (
        <div className="relative group animate-slide-up">
            {/* Glow Effect Background */}
            <div className={`absolute -inset-1 rounded-[2rem] opacity-20 blur-xl group-hover:opacity-40 transition duration-1000 group-hover:duration-200 
                ${role.includes("bat") ? "bg-emerald-500" : role.includes("bowl") ? "bg-blue-500" : "bg-accent"}`}></div>
            
            <div className="relative glass-card overflow-hidden">
                <div className="p-8">
                    <div className="flex flex-col md:flex-row justify-between items-start gap-6">
                        <div className="space-y-2">
                            <div className="flex items-center gap-3">
                                <span className={`text-xs font-bold uppercase tracking-widest ${roleColor}`}>
                                    {player.role}
                                </span>
                                {isOverseas && (
                                    <span className="bg-white/10 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter">
                                        Overseas
                                    </span>
                                )}
                            </div>
                            <h2 className="text-4xl md:text-5xl font-black text-white tracking-tight uppercase italic">
                                {player.name}
                            </h2>
                            <p className="text-slate-400 text-sm font-medium tracking-wide">
                                Base Price: <span className="text-white font-bold">₹{Number(player.base_price || 0).toFixed(2)} Cr</span>
                            </p>
                        </div>
                    </div>
                </div>
                
                {/* Decorative background element */}
                <div className="absolute right-0 bottom-0 opacity-5 pointer-events-none">
                     <span className="text-[120px] font-black italic tracking-tighter select-none uppercase">
                        {(player.role || "").split(' ')[0]}
                     </span>
                </div>
            </div>
        </div>
    );
}
