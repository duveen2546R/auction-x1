import { useEffect, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import socket from "../socket";

export default function Lobby() {
    const { roomId } = useParams();
    const { state } = useLocation();
    const navigate = useNavigate();
    const [players, setPlayers] = useState([]);

    const username = state?.username || localStorage.getItem("username") || "Player";
    const teamName = state?.teamName || localStorage.getItem("teamName") || "";
    const [error, setError] = useState(null);

    const slugMap = {
        "royal challengers bangalore": "banglore",
        "chennai super kings": "chennai",
        "delhi capitals": "delhi",
        "gujarat titans": "gujarat",
        "sunrisers hyderabad": "hyderabad",
        "kolkata knight riders": "kolkata",
        "lucknow super giants": "lucknow",
        "mumbai indians": "mumbai",
        "punjab kings": "punjab",
        "rajasthan royals": "rajasthan",
    };
    const bgSlug = teamName ? slugMap[teamName.toLowerCase()] || null : null;

    useEffect(() => {
        socket.emit("join_room", { roomId, username, teamName });

        socket.on("players_update", (playerList) => {
            setPlayers(playerList);
        });

        socket.on("start_auction", () => {
            navigate(`/auction/${roomId}`, { state: { username, teamName } });
        });

        socket.on("team_taken", (payload) => {
            setError(`Team ${payload.team} already taken. Choose another team.`);
        });

        return () => socket.off();
    }, [navigate, roomId, username, teamName]);

    return (
        <div
            className="min-h-screen text-slate-100 flex items-center justify-center px-4"
            style={
                bgSlug
                    ? {
                          backgroundImage: `linear-gradient(120deg, rgba(5,6,12,0.85), rgba(5,6,12,0.9)), url(/img/${bgSlug}.png)`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                      }
                    : { backgroundColor: "#05060c" }
            }
        >
            <div className="glass-card border border-border p-6 w-full max-w-3xl space-y-4 backdrop-blur">
                <div className="flex justify-between items-center">
                    <div>
                        <h2 className="text-2xl font-semibold">Room: {roomId}</h2>
                        <p className="text-slate-400 text-sm">Share this code with friends to join.</p>
                    </div>
                    <span className="pill small">Players {players.length}</span>
                </div>
                {error && <p className="text-amber-400 text-sm">{error}</p>}

                <div className="glass-card border border-border p-3">
                    <h3 className="font-semibold mb-2">Players</h3>
                    {players.map((p, i) => (
                        <div key={i} className="flex justify-between border-b border-border/60 py-2 text-sm">
                            <span>{p.username}</span>
                            {p.team && <span className="text-slate-400">{p.team}</span>}
                        </div>
                    ))}
                    {players.length === 0 && <p className="text-slate-400 text-sm">Waiting for players...</p>}
                </div>

                <button
                    className="primary-btn w-full"
                    disabled={players.length < 2}
                    onClick={() => socket.emit("start_auction", roomId)}
                >
                    Start Auction
                </button>
                {players.length < 2 && <p className="text-slate-400 text-xs">Need at least 2 players to start.</p>}
            </div>
        </div>
    );
}
