const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolvePreferredChatIdentity,
    shouldPersistChatIdentity,
} = require('../out/collaboration/chatIdentity.js');

test('resolvePreferredChatIdentity prefers the live socket identity when available', () => {
    const liveIdentity = { cookies: 'live-cookie', csrfToken: 'live-csrf' };
    const persistedIdentity = { cookies: 'persisted-cookie', csrfToken: 'persisted-csrf' };

    assert.equal(resolvePreferredChatIdentity(liveIdentity, persistedIdentity), liveIdentity);
});

test('resolvePreferredChatIdentity falls back to the persisted identity when the live identity is unusable', () => {
    const persistedIdentity = { cookies: 'persisted-cookie', csrfToken: 'persisted-csrf' };

    assert.equal(resolvePreferredChatIdentity({ cookies: '   ', csrfToken: '' }, persistedIdentity), persistedIdentity);
});

test('shouldPersistChatIdentity returns true when the live identity differs from persisted state', () => {
    assert.equal(shouldPersistChatIdentity(
        { cookies: 'live-cookie', csrfToken: 'live-csrf' },
        { cookies: 'persisted-cookie', csrfToken: 'persisted-csrf' },
    ), true);
});

test('shouldPersistChatIdentity returns false when the live identity is missing', () => {
    assert.equal(shouldPersistChatIdentity(undefined, { cookies: 'persisted-cookie', csrfToken: 'persisted-csrf' }), false);
});
