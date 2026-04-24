const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeChatMessage,
} = require('../out/collaboration/chatMessageFormatting.js');

test('normalizeChatMessage preserves Overleaf chat payloads without legacy rewriting', () => {
    const message = {
        id: 'message-1',
        content: 'Hi @Julio\n\n[[legacy syntax stays literal]]',
        edited_at: 123,
        timestamp: 10,
        user_id: 'user-2',
        user: {
            id: 'user-2',
            first_name: 'Test',
            last_name: 'User',
            email: 'test@example.com',
        },
        clientId: 'client-1',
    };

    assert.deepEqual(normalizeChatMessage(message), message);
});
