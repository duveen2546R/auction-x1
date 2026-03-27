import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearSession, getAuthToken, getStoredUsername } from "../session";

export default function History() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const apiBase = import.meta.env.VITE_API_URL || "http://localhost:5000";
  const token = getAuthToken();
  const username = getStoredUsername() || "Owner";
  const teamName = localStorage.getItem("teamName") || "";

  const openRoom = (item) => {
    if (!item?.canOpen) return;

    if (item.openTarget === "lobby") {
      navigate(`/lobby/${item.roomCode}`, {
        state: { username, teamName, joinIntent: "join" },
      });
      return;
    }

    navigate(`/auction/${item.roomCode}`, {
      state: { username, teamName },
    });
  };

  const exportPlaying11s = (item) => {
    const rows = Array.isArray(item?.leaderboard) ? item.leaderboard : [];
    if (!rows.length) return;

    const lines = [
      `ROOM ${item.roomCode} - SESSION ${item.sessionNumber || 1}`,
      "",
    ];

    rows.forEach((entry, index) => {
      lines.push(`${index + 1}. ${(entry.teamName || entry.username || "Team").toUpperCase()}`);
      const playing11 = Array.isArray(entry.playing11) ? entry.playing11 : [];
      if (playing11.length) {
        playing11.forEach((playerName, playerIndex) => {
          lines.push(`${playerIndex + 1}. ${playerName}`);
        });
      } else {
        lines.push("Playing XI not available");
      }
      lines.push("");
    });

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `room_${item.roomCode}_session_${item.sessionNumber || 1}_playing11.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!token) {
      navigate("/auth", { replace: true });
      return;
    }

    const fetchHistory = async () => {
      try {
        const res = await fetch(`${apiBase}/user/history`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const data = await res.json();
        if (res.status === 401) {
          clearSession();
          navigate("/auth", { replace: true });
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to fetch history");

        setHistory(Array.isArray(data.history) ? data.history : []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [apiBase, navigate, token]);

  const rankedRooms = useMemo(
    () => history.filter((item) => Array.isArray(item.leaderboard) && item.leaderboard.length > 0).length,
    [history]
  );

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[#020408]">
        <div className="w-12 h-12 border-4 border-white/10 border-t-accent rounded-full animate-spin"></div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest italic">Retrieving Battle Records...</p>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen text-slate-100 px-4 py-8 bg-[#020408]"
      style={{
        backgroundImage: "radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.05) 0%, transparent 50%)",
        backgroundAttachment: "fixed",
      }}
    >
      <div className="max-w-5xl mx-auto space-y-10">
        <header className="flex flex-col gap-6 border-b border-white/5 pb-8 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-accent">Career Archive</p>
            <h1 className="text-4xl font-black uppercase italic tracking-tight text-white">
              Recent <span className="text-slate-500">Rooms</span>
            </h1>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Signed in as {username}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white transition hover:border-accent/30 hover:text-accent"
            >
              Back To Arena
            </button>
            <button
              type="button"
              onClick={() => {
                clearSession();
                navigate("/auth");
              }}
              className="rounded-full border border-white/10 bg-transparent px-5 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 transition hover:border-rose-500/30 hover:text-rose-400"
            >
              Logout
            </button>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="glass-card p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Latest Rooms</p>
            <p className="mt-3 text-3xl font-black italic tracking-tight text-white">{history.length}</p>
          </div>
          <div className="glass-card p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Ranked Results</p>
            <p className="mt-3 text-3xl font-black italic tracking-tight text-accent">{rankedRooms}</p>
          </div>
          <div className="glass-card p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Saved Playing XI</p>
            <p className="mt-3 text-3xl font-black italic tracking-tight text-emerald-300">
              {history.filter((item) => item.yourPlaying11?.length).length}
            </p>
          </div>
        </section>

        {error && (
          <div className="glass-card border border-rose-500/20 p-4 text-center">
            <p className="text-[10px] font-black uppercase tracking-widest text-rose-400">{error}</p>
          </div>
        )}

        <section className="space-y-6">
          {history.length > 0 ? (
            history.map((item) => (
              <article key={`${item.roomId}-${item.roomCode}`} className="glass-card p-6 space-y-6">
                <div className="flex flex-col gap-4 border-b border-white/5 pb-6 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-accent">
                        Room {item.roomCode}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">
                        Session {item.sessionNumber || 1}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">
                        {item.status || "waiting"}
                      </span>
                    </div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                    <div className="flex flex-wrap items-center gap-6">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">Your Score</p>
                        <p className="mt-2 text-2xl font-black italic tracking-tight text-white">
                          {item.yourScore != null ? Number(item.yourScore).toFixed(1) : "N/A"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">Winner</p>
                        <p className="mt-2 text-lg font-black italic tracking-tight text-accent">
                          {item.winnerName || "Pending"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    {item.leaderboard?.length ? (
                      <button
                        type="button"
                        onClick={() => exportPlaying11s(item)}
                        className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-5 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-200 transition hover:border-emerald-400/40 hover:text-white"
                      >
                        Export Playing XIs
                      </button>
                    ) : null}
                    {item.canOpen ? (
                      <button
                        type="button"
                        onClick={() => openRoom(item)}
                        className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-white transition hover:border-accent/30 hover:text-accent"
                      >
                        Open Room
                      </button>
                    ) : (
                      <span className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                        Archived Session
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                  <section className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xs font-black uppercase tracking-widest italic text-white">Room Leaderboard</h2>
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                        {item.leaderboard?.length || 0} Results
                      </span>
                    </div>

                    {item.leaderboard?.length ? (
                      <div className="space-y-3">
                        {item.leaderboard.map((entry) => (
                          <div
                            key={`${item.roomId}-${entry.userId}`}
                            className="flex items-center justify-between rounded-2xl border border-white/5 bg-black/20 px-4 py-3"
                          >
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                                #{entry.rank}
                              </p>
                              <p className="mt-1 text-sm font-black uppercase italic tracking-tight text-white">
                                {entry.teamName || entry.username}
                              </p>
                            </div>
                            <p className="text-lg font-black italic tracking-tight text-accent">
                              {Number(entry.score || 0).toFixed(1)}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-white/5 bg-black/20 px-4 py-6 text-center">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                          Leaderboard will appear once the room finishes and Playing XI scores are saved.
                        </p>
                      </div>
                    )}
                  </section>

                  <section className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xs font-black uppercase tracking-widest italic text-white">Your Playing XI</h2>
                      <span className="text-[10px] font-black uppercase tracking-widest text-emerald-300">
                        {item.yourPlaying11?.length || 0} Picked
                      </span>
                    </div>

                    {item.yourPlaying11?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {item.yourPlaying11.map((player) => (
                          <span
                            key={`${item.roomId}-${player}`}
                            className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.15em] text-emerald-200"
                          >
                            {player}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-white/5 bg-black/20 px-4 py-6 text-center">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                          No saved Playing XI was found for this room yet.
                        </p>
                      </div>
                    )}
                  </section>
                </div>

                <section className="space-y-4 border-t border-white/5 pt-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-xs font-black uppercase tracking-widest italic text-white">Your Auction Squad</h2>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                      {item.yourSquad?.length || 0} Players
                    </span>
                  </div>

                  {item.yourSquad?.length ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {item.yourSquad.map((player) => (
                        <div
                          key={`${item.roomId}-${player.id}`}
                          className="rounded-2xl border border-white/5 bg-black/20 px-4 py-3"
                        >
                          <p className="text-sm font-black uppercase italic tracking-tight text-white">
                            {player.name}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] font-black uppercase tracking-widest text-slate-500">
                            <span>{player.role}</span>
                            <span>{player.country}</span>
                            <span>₹{Number(player.price || 0).toFixed(2)} Cr</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-white/5 bg-black/20 px-4 py-6 text-center">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                        No squad archive was found for this room yet.
                      </p>
                    </div>
                  )}
                </section>
              </article>
            ))
          ) : (
            <div className="glass-card px-6 py-16 text-center">
              <p className="text-xs font-black uppercase tracking-[0.2em] italic text-slate-500">
                No room history found yet.
              </p>
              <button
                type="button"
                onClick={() => navigate("/")}
                className="mt-6 rounded-xl border border-accent/30 bg-accent/10 px-6 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-accent transition hover:bg-accent/20"
              >
                Start Your First Auction
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
