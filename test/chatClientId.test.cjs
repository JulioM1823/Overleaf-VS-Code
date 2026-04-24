const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isOwnChatMessageClient,
    resolveActiveChatClientId,
} = require('../out/collaboration/chatClientId.js');

test('resolveActiveChatClientId prefers the live socket-assigned public id', () => {
    assert.equal(resolveActiveChatClientId('live-client-id', 'stale-client-id'), 'live-client-id');
});

test('resolveActiveChatClientId falls back to the initial public id when no live id exists yet', () => {
    assert.equal(resolveActiveChatClientId(undefined, 'initial-client-id'), 'initial-client-id');
});

test('resolveActiveChatClientId ignores empty ids', () => {
    assert.equal(resolveActiveChatClientId('   ', ''), undefined);
});

test('isOwnChatMessageClient confirms own messages from the live client id alone', () => {
    assert.equal(isOwnChatMessageClient('live-client-id', 'live-client-id'), true);
});

test('isOwnChatMessageClient ignores whitespace and does not require user id context', () => {
    assert.equal(isOwnChatMessageClient(' live-client-id ', 'live-client-id'), true);
    assert.equal(isOwnChatMessageClient('other-client-id', 'live-client-id'), false);
    assert.equal(isOwnChatMessageClient('', 'live-client-id'), false);
});
