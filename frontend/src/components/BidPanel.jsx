import { useCallback } from "react";

export default function BidPanel({ currentBid, step, budget, onBid, onWithdraw, onPass, isPassed = false, isEliminated = false, isSpectator = false, hasBidder = false }) {
    const suggested = hasBidder ? (Number(currentBid) + Number(step)) : Number(currentBid);
    const cannotAfford = suggested > (budget || 0);

    const placeBid = () => {
        onBid(suggested);
    };

    const isInteractionDisabled = isPassed || isEliminated || isSpectator;

    const handlePassDoubleClick = useCallback(() => {
        if (isInteractionDisabled) return;
        onPass();
    }, [isInteractionDisabled, onPass]);

    return (
        <div className="flex flex-col gap-6 p-2 sm:p-4">
            <div className="flex flex-wrap items-center gap-4 sm:gap-8">
                <button
                    className={`primary-btn px-6 sm:px-10 py-4 sm:py-5 text-lg sm:text-xl flex flex-col items-center justify-center min-w-full sm:min-w-[240px]
                               ${(isInteractionDisabled || cannotAfford) ? "opacity-30 cursor-not-allowed saturate-0" : ""}`}
                    onClick={placeBid}
                    disabled={isInteractionDisabled || cannotAfford}
                >
                    <span className="text-[10px] sm:text-sm font-bold uppercase tracking-widest opacity-70 mb-1">Place Bid</span>
                    <span className="text-xl sm:text-2xl font-black italic tracking-tighter tabular-nums">₹{suggested.toFixed(2)} Cr</span>
                </button>
                
                <div className="flex items-center gap-3 sm:gap-4 w-full sm:w-auto">
                    <button className="ghost-btn flex-1 sm:flex-none px-4 sm:px-6 py-3 sm:py-4 min-w-[100px] text-xs sm:text-base" onClick={onWithdraw} disabled={isEliminated || isSpectator}>
                        Withdraw
                    </button>
                    <button
                        className="ghost-btn flex-1 sm:flex-none px-4 sm:px-6 py-3 sm:py-4 min-w-[80px] text-xs sm:text-base"
                        onDoubleClick={handlePassDoubleClick}
                        disabled={isPassed || isEliminated || isSpectator}
                    >
                        Pass
                    </button>
                </div>
            </div>

            <div className="flex items-center gap-2 bg-white/5 border border-white/5 rounded-2xl p-3 sm:p-4 w-full sm:w-fit">
                <div className="flex flex-col">
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-none mb-2 text-center sm:text-left">Available Balance</span>
                    <span className={`text-xl sm:text-2xl font-black italic text-center sm:text-left ${cannotAfford ? "text-rose-500" : "text-accent"}`}>
                        ₹{budget?.toFixed(2)} <span className="text-sm">Cr</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
