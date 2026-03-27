import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearSession, getAuthToken } from "../session";

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const apiBase = import.meta.env.VITE_API_URL || "http://localhost:5000";

  useEffect(() => {
    const token = getAuthToken();
    if (!token) return;

    const verifySession = async () => {
      try {
        const res = await fetch(`${apiBase}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) throw new Error("expired");
        navigate("/", { replace: true });
      } catch {
        clearSession();
      }
    };

    verifySession();
  }, [apiBase, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!isLogin && password !== confirmPassword) {
        throw new Error("Passwords do not match");
      }

      const endpoint = isLogin ? "/auth/login" : "/auth/register";
      const res = await fetch(`${apiBase}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed");

      localStorage.setItem("token", data.token);
      localStorage.setItem("userId", String(data.user.id));
      localStorage.setItem("username", data.user.username);
      
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#020408]">
      <div className="max-w-md w-full glass-card p-8 space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-black italic tracking-tighter text-white uppercase">
            {isLogin ? "Login to Arena" : "Join the Ranks"}
          </h2>
          <p className="mt-2 text-slate-500 font-bold uppercase tracking-widest text-[10px]">
            AuctionXI Competition Platform
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2 block">
                Username
              </label>
              <input
                type="text"
                required
                className="w-full rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-accent transition-all"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2 block">
                Password
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
            {!isLogin && (
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
            )}
          </div>

          {error && (
            <div className="text-rose-500 text-[10px] font-bold uppercase tracking-widest text-center italic">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="primary-btn w-full !py-4 !rounded-xl text-sm font-black tracking-[0.2em] uppercase italic disabled:opacity-30"
          >
            {loading ? "Authenticating..." : (isLogin ? "Enter Arena" : "Register Account")}
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError("");
                setPassword("");
                setConfirmPassword("");
              }}
              className="text-[10px] font-black text-slate-500 hover:text-white uppercase tracking-[0.2em] transition-all"
            >
              {isLogin ? "Don't have an account? Sign Up" : "Already registered? Login"}
            </button>
          </div>
        </form>

        <div className="border-t border-white/5 pt-6 text-center">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Sign in to view your latest rooms, room leaderboards, and saved Playing XI history.
          </p>
        </div>
      </div>
    </div>
  );
}
