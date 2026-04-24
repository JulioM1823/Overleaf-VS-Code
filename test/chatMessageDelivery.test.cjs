const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isTemporaryChatMessageId,
    resolveChatMessageDelivery,
} = require('../out/collaboration/chatMessageDelivery.js');

test('isTemporaryChatMessageId recognizes pending live chat ids', () => {
    assert.equal(isTemporaryChatMessageId('pending-chat-123'), true);
});

test('isTemporaryChatMessageId recognizes offline queued chat ids', () => {
    assert.equal(isTemporaryChatMessageId('offline-chat-123'), true);
});

test('isTemporaryChatMessageId ignores confirmed server ids', () => {
    assert.equal(isTemporaryChatMessageId('66123456789abcdef012345'), false);
});

test('resolveChatMessageDelivery marks queued messages as pending queued', () => {
    assert.deepEqual(resolveChatMessageDelivery({
        isQueued: true,
        messageId: 'offline-chat-123',
    }), {
        detail: 'queued',
        state: 'pending',
    });
});

test('resolveChatMessageDelivery marks temporary non-queued messages as pending sending', () => {
    assert.deepEqual(resolveChatMessageDelivery({
        isQueued: false,
        messageId: 'pending-chat-123',
    }), {
        detail: 'sending',
        state: 'pending',
    });
});

test('resolveChatMessageDelivery marks confirmed server messages as delivered', () => {
    assert.deepEqual(resolveChatMessageDelivery({
        isQueued: false,
        messageId: '66123456789abcdef012345',
    }), {
        state: 'delivered',
    });
});
