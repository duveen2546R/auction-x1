export function getAuthToken() {
    return localStorage.getItem("token") || "";
}

export function getStoredUsername() {
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
}
