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

export async function sendPasswordResetEmail(email, resetUrl) {
  const config = getSmtpConfig();
  const transporter = await getTransporter();

  if (!transporter || !config.configured) {
    console.warn(`SMTP is not configured. Password reset link for ${email}: ${resetUrl}`);
    return { delivered: false, loggedOnly: true };
  }

  await transporter.sendMail({
    from: config.from,
    to: email,
    subject: "AuctionXI password reset",
    text: [
      "You requested a password reset for your AuctionXI account.",
      "",
      `Reset your password: ${resetUrl}`,
      "",
      "This link expires in 15 minutes.",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
        <h2 style="margin-bottom: 12px;">AuctionXI Password Reset</h2>
        <p>You requested a password reset for your AuctionXI account.</p>
        <p>
          <a href="${resetUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 8px; background: #22d3ee; color: #020617; text-decoration: none; font-weight: 700;">
            Reset Password
          </a>
        </p>
        <p style="margin-top: 16px;">This link expires in 15 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  return { delivered: true, loggedOnly: false };
}
