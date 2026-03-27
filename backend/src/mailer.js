let transporterPromise = null;

function getSmtpConfig() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const from = String(process.env.MAIL_FROM || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    String(process.env.SMTP_SECURE || "").trim().toLowerCase() === "true" || port === 465;

  return {
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : null,
    from,
    configured: Boolean(host && from && user && pass),
  };
}

async function getTransporter() {
  if (transporterPromise) {
    return transporterPromise;
  }

  transporterPromise = (async () => {
    const config = getSmtpConfig();
    if (!config.configured) {
      return null;
    }

    const nodemailerModule = await import("nodemailer");
    const nodemailer = nodemailerModule.default || nodemailerModule;

    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
    });
  })();

  return transporterPromise;
}

export function getPasswordResetBaseUrl() {
  return String(process.env.FRONTEND_ORIGIN || "http://localhost:5173").trim().replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "N/A";
}

function formatCr(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(2)} Cr` : "0.00 Cr";
}

function renderShell({ eyebrow, title, subtitle, bodyHtml }) {
  return `
    <div style="margin:0;padding:32px 16px;background:#020408;background-image:radial-gradient(circle at top, rgba(103,232,249,0.1) 0%, rgba(2,4,8,1) 55%);font-family:Arial,Helvetica,sans-serif;color:#e2e8f0;">
      <div style="max-width:760px;margin:0 auto;border:1px solid rgba(255,255,255,0.08);border-radius:28px;overflow:hidden;background:rgba(10,14,23,0.94);box-shadow:0 24px 60px rgba(0,0,0,0.45);">
        <div style="padding:32px 32px 20px;border-bottom:1px solid rgba(255,255,255,0.06);background:linear-gradient(135deg, rgba(103,232,249,0.12), rgba(15,23,42,0.2));">
          <div style="font-size:11px;letter-spacing:0.35em;text-transform:uppercase;font-weight:800;color:#67e8f9;">${escapeHtml(eyebrow)}</div>
          <h1 style="margin:16px 0 10px;font-size:36px;line-height:1.05;font-weight:900;color:#ffffff;text-transform:uppercase;font-style:italic;letter-spacing:-0.04em;">${escapeHtml(title)}</h1>
          <p style="margin:0;font-size:13px;line-height:1.7;color:#94a3b8;text-transform:uppercase;letter-spacing:0.18em;font-weight:700;">${escapeHtml(subtitle)}</p>
        </div>
        <div style="padding:28px 32px 36px;">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `;
}

function renderStatCard(label, value, accent = "#67e8f9") {
  return `
    <div style="flex:1 1 180px;min-width:180px;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:18px 18px 16px;background:rgba(255,255,255,0.03);">
      <div style="font-size:10px;letter-spacing:0.24em;text-transform:uppercase;font-weight:800;color:#64748b;">${escapeHtml(label)}</div>
      <div style="margin-top:10px;font-size:28px;font-style:italic;font-weight:900;letter-spacing:-0.03em;color:${accent};">${escapeHtml(value)}</div>
    </div>
  `;
}

async function sendMail({ to, subject, text, html, fallbackLabel }) {
  const config = getSmtpConfig();
  const transporter = await getTransporter();

  if (!transporter || !config.configured) {
    console.warn(`SMTP is not configured. ${fallbackLabel}`);
    return { delivered: false, loggedOnly: true };
  }

  await transporter.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html,
  });

  return { delivered: true, loggedOnly: false };
}

export async function sendPasswordResetEmail(email, resetUrl) {
  const text = [
    "You requested a password reset for your AuctionXI account.",
    "",
    `Reset your password: ${resetUrl}`,
    "",
    "This link expires in 15 minutes.",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const html = renderShell({
    eyebrow: "Security Reset",
    title: "Password Reset",
    subtitle: "Secure your AuctionXI access",
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:15px;line-height:1.8;color:#cbd5e1;">
        You requested a password reset for your AuctionXI account.
      </p>
      <div style="margin:24px 0;">
        <a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:#67e8f9;color:#020617;text-decoration:none;font-size:13px;font-weight:900;letter-spacing:0.18em;text-transform:uppercase;">
          Reset Password
        </a>
      </div>
      <div style="border:1px solid rgba(103,232,249,0.16);border-radius:18px;padding:18px;background:rgba(103,232,249,0.08);">
        <div style="font-size:10px;letter-spacing:0.24em;text-transform:uppercase;font-weight:800;color:#67e8f9;">Reset Link</div>
        <div style="margin-top:10px;word-break:break-all;font-size:13px;line-height:1.7;color:#e2e8f0;">${escapeHtml(resetUrl)}</div>
      </div>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.7;color:#94a3b8;">
        This link expires in 15 minutes. If you did not request this, you can ignore this email.
      </p>
    `,
  });

  return sendMail({
    to: email,
    subject: "AuctionXI password reset",
    text,
    html,
    fallbackLabel: `Password reset link for ${email}: ${resetUrl}`,
  });
}

export async function sendWelcomeEmail({ email, username }) {
  const appUrl = getPasswordResetBaseUrl();
  const text = [
    `Welcome to AuctionXI, ${username}.`,
    "",
    "Your franchise war room is ready.",
    `Enter the arena: ${appUrl}`,
  ].join("\n");

  const html = renderShell({
    eyebrow: "Welcome To The Arena",
    title: `Captain ${username}`,
    subtitle: "Your AuctionXI account is live",
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:15px;line-height:1.8;color:#cbd5e1;">
        Your account has been created successfully. The auction lobby, history archive, Playing XI tools, and password recovery are all ready for you.
      </p>
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin:26px 0 28px;">
        ${renderStatCard("Status", "Ready", "#67e8f9")}
        ${renderStatCard("Access", "Account Active", "#86efac")}
      </div>
      <div style="margin:22px 0;">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:#67e8f9;color:#020617;text-decoration:none;font-size:13px;font-weight:900;letter-spacing:0.18em;text-transform:uppercase;">
          Enter Arena
        </a>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.8;color:#94a3b8;">
        Build your squad, finish your auctions, and export every Playing XI from your room history.
      </p>
    `,
  });

  return sendMail({
    to: email,
    subject: "Welcome to AuctionXI",
    text,
    html,
    fallbackLabel: `Welcome email for ${email} was not sent. App URL: ${appUrl}`,
  });
}

export async function sendAuctionCompletionEmail({
  to,
  username,
  teamName,
  roomCode,
  sessionNumber,
  winnerName,
  yourScore,
  yourSquad = [],
  yourPlaying11 = [],
  leaderboard = [],
  disqualified = false,
}) {
  const teamLabel = teamName || username || "Franchise";
  const appUrl = `${getPasswordResetBaseUrl()}/history`;
  const leaderboardRows = leaderboard
    .map(
      (entry, index) => `
        <tr>
          <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;font-weight:900;color:#67e8f9;">#${index + 1}</td>
          <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;font-weight:800;color:#f8fafc;text-transform:uppercase;">${escapeHtml(entry.teamName || entry.username || "Team")}</td>
          <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;font-weight:900;color:#86efac;text-align:right;">${escapeHtml(formatScore(entry.score))}</td>
        </tr>
      `
    )
    .join("");

  const squadHtml = yourSquad.length
    ? yourSquad
        .map(
          (player) => `
            <div style="border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:12px 14px;background:rgba(255,255,255,0.03);">
              <div style="font-size:13px;font-weight:900;color:#f8fafc;text-transform:uppercase;font-style:italic;">${escapeHtml(player.name)}</div>
              <div style="margin-top:8px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;font-weight:800;color:#94a3b8;">${escapeHtml(player.role || "Player")} · ${escapeHtml(player.country || "Unknown")} · ${escapeHtml(formatCr(player.price || 0))}</div>
            </div>
          `
        )
        .join("")
    : `<div style="font-size:13px;color:#94a3b8;">No squad data was saved for this session.</div>`;

  const playing11Html = yourPlaying11.length
    ? yourPlaying11
        .map(
          (playerName, index) => `
            <div style="padding:10px 12px;border-radius:12px;border:1px solid rgba(103,232,249,0.16);background:rgba(103,232,249,0.08);font-size:12px;font-weight:900;color:#e0f2fe;text-transform:uppercase;letter-spacing:0.12em;">
              ${index + 1}. ${escapeHtml(playerName)}
            </div>
          `
        )
        .join("")
    : `<div style="font-size:13px;color:#94a3b8;">${disqualified ? "No valid Playing XI was submitted for this team." : "No Playing XI was saved for this team."}</div>`;

  const html = renderShell({
    eyebrow: `Room ${roomCode} · Session ${sessionNumber || 1}`,
    title: "Auction Completed",
    subtitle: `${teamLabel} final report`,
    bodyHtml: `
      <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:26px;">
        ${renderStatCard("Winner", winnerName || "No Winner", "#67e8f9")}
        ${renderStatCard("Your Score", disqualified ? "DQ" : formatScore(yourScore), disqualified ? "#fda4af" : "#86efac")}
      </div>

      <div style="border:1px solid rgba(255,255,255,0.06);border-radius:22px;padding:22px;background:rgba(255,255,255,0.03);margin-bottom:22px;">
        <div style="font-size:12px;letter-spacing:0.24em;text-transform:uppercase;font-weight:900;color:#67e8f9;">Live Leaderboard</div>
        <table style="width:100%;margin-top:16px;border-collapse:collapse;">
          <thead>
            <tr>
              <th style="padding:0 14px 10px;text-align:left;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#64748b;">Rank</th>
              <th style="padding:0 14px 10px;text-align:left;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#64748b;">Franchise</th>
              <th style="padding:0 14px 10px;text-align:right;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#64748b;">Points</th>
            </tr>
          </thead>
          <tbody>
            ${leaderboardRows || `<tr><td colspan="3" style="padding:12px 14px;font-size:13px;color:#94a3b8;">Leaderboard unavailable</td></tr>`}
          </tbody>
        </table>
      </div>

      <div style="display:grid;grid-template-columns:1fr;gap:22px;">
        <div style="border:1px solid rgba(255,255,255,0.06);border-radius:22px;padding:22px;background:rgba(255,255,255,0.03);">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;">
            <div style="font-size:12px;letter-spacing:0.24em;text-transform:uppercase;font-weight:900;color:#67e8f9;">Your Playing XI</div>
            <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;font-weight:800;color:${disqualified ? "#fda4af" : "#86efac"};">${disqualified ? "Disqualified" : `${yourPlaying11.length} Picked`}</div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:16px;">
            ${playing11Html}
          </div>
        </div>

        <div style="border:1px solid rgba(255,255,255,0.06);border-radius:22px;padding:22px;background:rgba(255,255,255,0.03);">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;">
            <div style="font-size:12px;letter-spacing:0.24em;text-transform:uppercase;font-weight:900;color:#67e8f9;">Your Squad</div>
            <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;font-weight:800;color:#94a3b8;">${yourSquad.length} Players</div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:16px;">
            ${squadHtml}
          </div>
        </div>
      </div>

      <div style="margin-top:28px;">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:#67e8f9;color:#020617;text-decoration:none;font-size:13px;font-weight:900;letter-spacing:0.18em;text-transform:uppercase;">
          Open Recent Rooms
        </a>
      </div>
    `,
  });

  const text = [
    `AuctionXI room ${roomCode} session ${sessionNumber || 1} is complete.`,
    `Winner: ${winnerName || "No winner"}`,
    `Your team: ${teamLabel}`,
    `Your score: ${disqualified ? "Disqualified" : formatScore(yourScore)}`,
    "",
    "Leaderboard:",
    ...leaderboard.map((entry, index) => `${index + 1}. ${entry.teamName || entry.username} - ${formatScore(entry.score)}`),
    "",
    "Your Playing XI:",
    ...(yourPlaying11.length ? yourPlaying11.map((name, index) => `${index + 1}. ${name}`) : [disqualified ? "Disqualified" : "No Playing XI saved"]),
    "",
    "Your Squad:",
    ...(yourSquad.length ? yourSquad.map((player) => `- ${player.name} (${player.role}) ${formatCr(player.price || 0)}`) : ["No squad data saved"]),
  ].join("\n");

  return sendMail({
    to,
    subject: `AuctionXI final report for room ${roomCode}`,
    text,
    html,
    fallbackLabel: `Auction completion email for ${to} in room ${roomCode} was not sent.`,
  });
}
