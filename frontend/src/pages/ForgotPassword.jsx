import { useState } from "react";
import { Link } from "react-router-dom";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [debugResetUrl, setDebugResetUrl] = useState("");

  const apiBase = import.meta.env.VITE_API_URL || "http://localhost:5000";

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    setDebugResetUrl("");

    try {
      const res = await fetch(`${apiBase}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to send reset link");
      }

      setMessage(data.message || "If that email is registered, a reset link has been sent.");
      if (data.debugResetUrl) {
        setDebugResetUrl(data.debugResetUrl);
      }
    } catch (err) {
      setError(err.message || "Failed to send reset link");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#020408]">
      <div className="max-w-md w-full glass-card p-8 space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-black italic tracking-tighter text-white uppercase">
            Forgot Password
          </h2>
          <p className="mt-2 text-slate-500 font-bold uppercase tracking-widest text-[10px]">
            Reset your AuctionXI account password
          </p>
        </div>

        <form className="space-y-6" onSubmit={handleSubmit}>
          <div>
            <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2 block">
              Registered Email
            </label>
            <input
              type="email"
              required
              className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {error && (
            <div className="text-rose-500 text-[10px] font-bold uppercase tracking-widest text-center italic">
              {error}
            </div>
          )}

          {message && (
            <div className="text-emerald-300 text-[10px] font-bold uppercase tracking-widest text-center italic">
              {message}
            </div>
          )}

          {debugResetUrl && (
            <div className="rounded-xl border border-accent/20 bg-accent/10 p-4 text-left">
              <p className="text-[10px] font-black uppercase tracking-widest text-accent">Local Reset Link</p>
              <a
                href={debugResetUrl}
                className="mt-3 block break-all text-xs font-bold text-white underline underline-offset-4"
              >
                {debugResetUrl}
              </a>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30"
          >
            {loading ? "Sending Link..." : "Send Reset Link"}
          </button>
        </form>

        <div className="text-center">
          <Link
            to="/auth"
            className="text-[10px] font-black text-slate-500 hover:text-white uppercase tracking-[0.2em] transition-all"
          >
            Back To Login
          </Link>
        </div>
      </div>
    </div>
  );
}
