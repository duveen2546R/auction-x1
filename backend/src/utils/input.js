export function normalizeUsernameInput(value) {
  const username = String(value || "").trim().replace(/\s+/g, " ");
  if (username.length < 3 || username.length > 50) return null;
  return username;
}

export function normalizePasswordInput(value) {
  return String(value || "");
}

export function normalizeEmailInput(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return null;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(email) ? email : null;
}

export function parseLineupIds(lineup) {
  if (!Array.isArray(lineup)) return [];
  return lineup
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
