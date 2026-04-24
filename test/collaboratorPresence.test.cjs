const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isOwnCollaboratorPresence,
    resolveCollaboratorPresenceKey,
} = require('../out/collaboration/collaboratorPresence.js');

test('resolveCollaboratorPresenceKey prefers stable user ids over ephemeral client ids', () => {
    assert.equal(resolveCollaboratorPresenceKey({
        clientId: 'client-1',
        userId: 'user-1',
    }), 'user-1');
    assert.equal(resolveCollaboratorPresenceKey({
        clientId: 'client-2',
        existingUserId: 'user-2',
    }), 'user-2');
});

test('resolveCollaboratorPresenceKey falls back to the client id when no user id exists', () => {
    assert.equal(resolveCollaboratorPresenceKey({
        clientId: 'client-3',
    }), 'client-3');
});

test('isOwnCollaboratorPresence filters self by stable user id even if client ids differ', () => {
    assert.equal(isOwnCollaboratorPresence({
        clientId: 'stale-client-id',
        selfClientId: 'live-client-id',
        selfUserId: 'user-1',
        userId: 'user-1',
    }), true);
});

test('isOwnCollaboratorPresence still falls back to matching the current client id', () => {
    assert.equal(isOwnCollaboratorPresence({
        clientId: 'live-client-id',
        selfClientId: 'live-client-id',
    }), true);
    assert.equal(isOwnCollaboratorPresence({
        clientId: 'other-client-id',
        selfClientId: 'live-client-id',
        selfUserId: 'user-1',
        userId: 'user-2',
    }), false);
});
