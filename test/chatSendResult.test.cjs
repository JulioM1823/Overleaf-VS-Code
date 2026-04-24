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

test('buildOverleafChatSendFailure normalizes preview text for server errors', () => {
    const failure = buildOverleafChatSendFailure({
        statusCode: 500,
        responseBody: '<html> Internal server error </html>',
        route: 'project/123/messages',
    });
    assert.equal(failure.code, 'server-error');
    assert.equal(failure.route, 'project/123/messages');
    assert.equal(failure.responsePreview, 'Internal server error');
});

test('formatOverleafChatSendFailureMessage preserves the connecting message', () => {
    assert.equal(
        formatOverleafChatSendFailureMessage('missing-client-id'),
        'Overleaf chat is still connecting. Try again in a moment.',
    );
});

