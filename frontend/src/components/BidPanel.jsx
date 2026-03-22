import { useState } from "react";

export default function BidPanel({ currentBid, step, budget, onBid, onWithdraw, onPass, isPassed = false, isEliminated = false }) {
    const suggested = Number(currentBid) + Number(step);

    const placeBid = () => {
        onBid(suggested);
    };

    return (
        <div className="flex flex-wrap items-center gap-3">
            <button
                className="primary-btn px-6 py-3"
                onClick={placeBid}
                disabled={isPassed || isEliminated || suggested > (budget || 0)}
            >
                Bid ₹{suggested.toFixed(2)} Cr (step {step} Cr)
            </button>
            <button className="ghost-btn" onClick={onWithdraw} disabled={isEliminated}>
                Withdraw
            </button>
            <button className="ghost-btn" onClick={onPass} disabled={isPassed || isEliminated}>
                Pass
            </button>
            <span className="text-sm text-slate-400">Balance: ₹{budget?.toFixed(2)} Cr</span>
        </div>
    );
}
