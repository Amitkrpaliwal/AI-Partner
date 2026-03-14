/**
 * API configuration — single source of truth for the backend URL.
 *
 * Uses VITE_API_URL env variable when set, otherwise defaults to
 * empty string (relative URLs, same origin).
 */
export const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Auth token management.
 * JWT is stored in an httpOnly cookie (set by server),
 * but we also keep a copy for Authorization header fallback
 * and Socket.IO auth handshake.
 */
let authToken: string | null = null;

export function setAuthToken(token: string | null) {
    authToken = token;
    if (token) {
        localStorage.setItem('ai_partner_token', token);
    } else {
        localStorage.removeItem('ai_partner_token');
    }
}

export function getAuthToken(): string | null {
    if (authToken) return authToken;
    return localStorage.getItem('ai_partner_token');
}

export function clearAuth() {
    authToken = null;
    localStorage.removeItem('ai_partner_token');
}

/**
 * Fetch wrapper that attaches JWT and handles 401 redirects.
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = getAuthToken();
    const headers = new Headers(options.headers || {});

    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
        headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, {
        ...options,
        headers,
        credentials: 'include', // Send httpOnly cookies
    });

    // Auto-clear auth on 401 (token expired / invalid)
    if (res.status === 401) {
        clearAuth();
        // Dispatch custom event so App can show login
        window.dispatchEvent(new CustomEvent('auth:expired'));
    }

    return res;
}
