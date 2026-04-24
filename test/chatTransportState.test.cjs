const test = require('node:test');
const assert = require('node:assert/strict');

const {
    canFetchRemoteChatHistory,
    canSendLiveChatMessages,
} = require('../out/collaboration/chatTransportState.js');

test('canFetchRemoteChatHistory stays available during non-offline recovery modes', () => {
    assert.equal(canFetchRemoteChatHistory({
        bootstrapSource: 'socket',
    }), true);
    assert.equal(canFetchRemoteChatHistory({
        bootstrapSource: 'fallback',
    }), true);
});

test('canFetchRemoteChatHistory still attempts network fetches from offline snapshots', () => {
    assert.equal(canFetchRemoteChatHistory({
        bootstrapSource: 'offline',
    }), true);
});

test('canSendLiveChatMessages requires both a remote bootstrap and a chat client id', () => {
    assert.equal(canSendLiveChatMessages({
        activeChatClientId: 'client-123',
        bootstrapSource: 'socket',
    }), true);
    assert.equal(canSendLiveChatMessages({
        activeChatClientId: '   ',
        bootstrapSource: 'socket',
    }), false);
    assert.equal(canSendLiveChatMessages({
        activeChatClientId: 'client-123',
        bootstrapSource: 'offline',
    }), true);
});
