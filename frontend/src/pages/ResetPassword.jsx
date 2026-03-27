import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => searchParams.get("token") || "", [searchParams]);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const apiBase = import.meta.env.VITE_API_URL || "http://localhost:5000";

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!token) {
      setError("Reset token is missing");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to reset password");
      }

      setMessage(data.message || "Password reset successful");
      setTimeout(() => navigate("/auth"), 1200);
    } catch (err) {
      setError(err.message || "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#020408]">
      <div className="max-w-md w-full glass-card p-8 space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-black italic tracking-tighter text-white uppercase">
            Reset Password
          </h2>
          <p className="mt-2 text-slate-500 font-bold uppercase tracking-widest text-[10px]">
            Set a new password for your AuctionXI account
          </p>
        </div>

        <form className="space-y-6" onSubmit={handleSubmit}>
          <div>
            <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2 block">
              New Password
            </label>
            <div className="flex items-center gap-2">
              <input
                type={showPassword ? "text" : "password"}
                required
                className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-slate-300 transition hover:border-accent/30 hover:text-accent"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2 block">
              Re-enter Password
            </label>
            <input
              type={showPassword ? "text" : "password"}
              required
              className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
              placeholder="Re-enter password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
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

          <button
            type="submit"
            disabled={loading}
            className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30"
          >
            {loading ? "Updating Password..." : "Reset Password"}
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
