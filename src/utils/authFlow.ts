export type LoginMethod = 'cookies' | 'password';

export function resolveLoginMethod(auth: {[key: string]: string}): LoginMethod {
    return auth.cookies ? 'cookies' : 'password';
}

export function buildAuthAttemptFields(auth: {[key: string]: string}) {
    const method = resolveLoginMethod(auth);
    return {
        cookieLength: method === 'cookies' ? auth.cookies.length : 0,
        emailProvided: Boolean(auth.email),
        method,
    };
}

export function buildLoginFailureMessage(method: LoginMethod) {
    switch (method) {
        case 'cookies':
            return 'Login failed. Verify the cookie value came from an already authenticated /project page request.';
        case 'password':
        default:
            return 'Login failed. Check your credentials, or use Login with Cookies for SSO, browser-only sign-in, or captcha-enabled servers.';
    }
}

export function buildSessionExpiredMessage() {
    return 'Session expired. Please sign in again. For SSO or captcha-enabled servers, use Login with Cookies.';
}

export function buildNotAuthenticatedMessage(serverName: string) {
    return `No authenticated session is available for ${serverName}. Sign in again from the Overleaf sidebar.`;
}

export function buildPasswordLoginUnavailableMessage() {
    return 'Native email/password login is not available for this Overleaf session because the server requires CAPTCHA or browser-based sign-in. Use Login with Cookies instead.';
}

export function buildBrowserAssistedLoginMessage(serverName: string) {
    return `Complete sign-in for ${serverName} in your browser. When you reach the Overleaf project dashboard, choose Paste Cookies and provide the Cookie header from an authenticated /project request.`;
}

export function buildBrowserAssistedLoginPrompt() {
    return 'Paste the Cookie header from an authenticated /project request after you finish signing in in the browser.';
}
