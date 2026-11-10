const test = require('node:test');
const assert = require('node:assert/strict');

const {
    mergeCookieHeaders,
    normalizeCookieHeader,
} = require('../out/api/cookieHelpers.js');

test('normalizeCookieHeader keeps request cookies and drops set-cookie attributes', () => {
    assert.equal(
        normalizeCookieHeader('Cookie: overleaf_session2=session; GCLB=sticky; Path=/; HttpOnly'),
        'overleaf_session2=session; GCLB=sticky',
    );
});

test('mergeCookieHeaders adds new cookies and overwrites stale values', () => {
    assert.equal(
        mergeCookieHeaders(
            'overleaf_session2=session; GCLB=old',
            [
                'GCLB=new; Path=/; HttpOnly',
                'socketSession=abc123; Secure; SameSite=None',
            ],
        ),
        'overleaf_session2=session; GCLB=new; socketSession=abc123',
    );
});

test('mergeCookieHeaders can bootstrap a cookie header from set-cookie values alone', () => {
    assert.equal(
        mergeCookieHeaders('', [
            'sharelatex.sid=s%3Aabc.def; Path=/; HttpOnly',
        ]),
        'sharelatex.sid=s%3Aabc.def',
    );
});

test('cookie helpers reject unsafe header characters and malformed names', () => {
    assert.equal(
        normalizeCookieHeader('Cookie: overleaf_session2=session\r\nX-Leak: yes; GCLB=sticky'),
        '',
    );
    assert.equal(
        mergeCookieHeaders('safe=ok; bad name=value', [
            'evil=bad\r\nSet-Cookie: injected=1; Path=/',
            'good=new; Path=/; HttpOnly',
        ]),
        'safe=ok; good=new',
    );
});
