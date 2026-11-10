const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildOverleafChatSendFailure,
    classifyOverleafChatSendFailure,
    formatOverleafChatSendFailureMessage,
} = require('../out/collaboration/chatSendResult.js');

test('classifyOverleafChatSendFailure treats 401 responses as auth failures', () => {
    assert.equal(classifyOverleafChatSendFailure({
        statusCode: 401,
        responseBody: 'please sign in again',
    }), 'auth-invalid');
});

test('classifyOverleafChatSendFailure treats csrf-related 403 responses as auth failures', () => {
    assert.equal(classifyOverleafChatSendFailure({
        statusCode: 403,
        responseBody: 'Invalid CSRF token',
    }), 'auth-invalid');
});

test('classifyOverleafChatSendFailure treats generic 403 responses as permission failures', () => {
    assert.equal(classifyOverleafChatSendFailure({
        statusCode: 403,
        responseBody: 'Forbidden',
    }), 'permission-denied');
});

test('classifyOverleafChatSendFailure treats 429 responses as rate limiting', () => {
    assert.equal(classifyOverleafChatSendFailure({
        statusCode: 429,
        responseBody: 'Too many requests',
    }), 'rate-limited');
});

test('buildOverleafChatSendFailure keeps server response previews out of user-facing messages', () => {
    const failure = buildOverleafChatSendFailure({
        statusCode: 500,
        responseBody: '<html> Internal server error for private-project-name </html>',
        route: 'project/123/messages',
    });
    assert.equal(failure.code, 'server-error');
    assert.equal(failure.route, 'project/123/messages');
    assert.equal(failure.responsePreview, 'Internal server error for private-project-name');
    assert.equal(failure.message, 'Unable to send the Overleaf chat message due to an Overleaf server error. (500)');
    assert.equal(failure.message.includes('private-project-name'), false);
});

test('formatOverleafChatSendFailureMessage does not append server previews', () => {
    assert.equal(
        formatOverleafChatSendFailureMessage('validation-failed', (message) => message, {
            responsePreview: 'validation details mentioning private text',
            statusCode: 422,
        }),
        'Unable to send the Overleaf chat message because Overleaf rejected the message payload. (422)',
    );
});

test('formatOverleafChatSendFailureMessage preserves the connecting message', () => {
    assert.equal(
        formatOverleafChatSendFailureMessage('missing-client-id'),
        'Overleaf chat is still connecting. Try again in a moment.',
    );
});
