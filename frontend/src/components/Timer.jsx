import React from 'react';

export default function Timer({ percent = 100, ms = 13000 }) {
    const seconds = (ms / 1000).toFixed(1);
    const isWarning = percent <= 40;

    return (
        <div className="w-full space-y-2">
            <div className="flex justify-between items-end">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em]">Auction Countdown</span>
                <span className={`text-sm font-black italic tabular-nums ${isWarning ? "animate-pulse text-rose-500" : "text-white"}`}>
                    {seconds}s
                </span>
            </div>
            
            <div className="timer-container h-2">
                <div 
                    className={`timer-bar ${isWarning ? 'warning' : ''} animate-shimmer`}
                    style={{ 
                        width: `${percent}%`,
                        backgroundImage: 'linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.1) 75%, transparent 75%, transparent)',
                        backgroundSize: '20px 20px'
                    }}
                >
                </div>
            </div>
        </div>
    );
}
