const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isLikelyConnectivityFailure,
} = require('../out/core/offlineSyncState.js');

test('isLikelyConnectivityFailure recognizes ENETUNREACH request failures', () => {
    const error = new Error('request to https://www.overleaf.com/project/thread/messages failed, reason: connect ENETUNREACH 34.120.52.64:443');
    assert.equal(isLikelyConnectivityFailure(error), true);
});

test('isLikelyConnectivityFailure recognizes transient DNS retry failures', () => {
    const error = new Error('getaddrinfo EAI_AGAIN www.overleaf.com');
    assert.equal(isLikelyConnectivityFailure(error), true);
});
