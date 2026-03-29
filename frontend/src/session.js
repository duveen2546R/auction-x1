export function getAuthToken() {
    return localStorage.getItem("token") || "";
}

function decodeTokenPayload(token) {
    const value = String(token || "").trim();
    const parts = value.split(".");
    if (parts.length !== 3) return null;

    try {
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const payload = JSON.parse(atob(padded));
        return payload && typeof payload === "object" ? payload : null;
    } catch {
        return null;
    }
}

export function getStoredUsername() {
    const tokenUsername = String(decodeTokenPayload(getAuthToken())?.username || "").trim();
    if (tokenUsername) {
        if (localStorage.getItem("username") !== tokenUsername) {
            localStorage.setItem("username", tokenUsername);
        }
        return tokenUsername;
    }

    return localStorage.getItem("username") || "";
}

export function getStoredUserId() {
    const value = localStorage.getItem("userId");
    if (!value || value === "undefined" || value === "null") return null;

    const numericValue = Number(value);
    return Number.isInteger(numericValue) ? numericValue : null;
}

export function clearSession() {
    localStorage.removeItem("token");
    localStorage.removeItem("userId");
    localStorage.removeItem("username");
    localStorage.removeItem("activeRoomId");
}
