const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildAuthAttemptFields,
    buildBrowserAssistedLoginMessage,
    buildBrowserAssistedLoginPrompt,
    buildLoginFailureMessage,
    buildNotAuthenticatedMessage,
    buildPasswordLoginUnavailableMessage,
    buildSessionExpiredMessage,
    resolveLoginMethod,
} = require('../out/utils/authFlow.js');

test('resolveLoginMethod distinguishes cookies and password flows', () => {
    assert.equal(resolveLoginMethod({cookies: 'sharelatex.sid=abc'}), 'cookies');
    assert.equal(resolveLoginMethod({email: 'user@example.com', password: 'secret'}), 'password');
});

test('buildAuthAttemptFields captures only safe login metadata', () => {
    assert.deepEqual(
        buildAuthAttemptFields({email: 'user@example.com', password: 'secret'}),
        {
            cookieLength: 0,
            emailProvided: true,
            method: 'password',
        },
    );
    assert.deepEqual(
        buildAuthAttemptFields({cookies: 'sharelatex.sid=abc'}),
        {
            cookieLength: 18,
            emailProvided: false,
            method: 'cookies',
        },
    );
});

test('buildLoginFailureMessage explains the likely next step', () => {
    assert.match(buildLoginFailureMessage('cookies'), /project page request/i);
    assert.match(buildLoginFailureMessage('password'), /Login with Cookies/i);
});

test('session/auth messages remain explicit and actionable', () => {
    assert.match(buildSessionExpiredMessage(), /Session expired/i);
    assert.match(buildSessionExpiredMessage(), /Login with Cookies/i);
    assert.match(buildPasswordLoginUnavailableMessage(), /CAPTCHA/i);
    assert.match(buildPasswordLoginUnavailableMessage(), /Login with Cookies/i);
    assert.match(buildBrowserAssistedLoginMessage('www.overleaf.com'), /Complete sign-in/i);
    assert.match(buildBrowserAssistedLoginMessage('www.overleaf.com'), /Paste Cookies/i);
    assert.match(buildBrowserAssistedLoginPrompt(), /Cookie header/i);
    assert.equal(
        buildNotAuthenticatedMessage('www.overleaf.com'),
        'No authenticated session is available for www.overleaf.com. Sign in again from the Overleaf sidebar.',
    );
});
