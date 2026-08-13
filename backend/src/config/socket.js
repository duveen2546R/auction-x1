export function getSocketCorsOptions() {
  const explicitOrigins = ["http://localhost:5173", process.env.FRONTEND_ORIGIN].filter(Boolean);
  const origin = process.env.FRONTEND_ORIGIN ? explicitOrigins : true;

  console.log(
    "Allowed CORS Origins:",
    process.env.FRONTEND_ORIGIN ? explicitOrigins : "ALL (reflect origin)"
  );

  return {
    origin,
    methods: ["GET", "POST"],
    credentials: true,
  };
}
