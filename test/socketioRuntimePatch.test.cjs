const test = require('node:test');
const assert = require('node:assert/strict');

const { patchSocketIoClientForNode } = require('../out/api/socketioRuntimePatch.js');

test('patchSocketIoClientForNode disables header checks on created XHR instances', () => {
    let disableHeaderCheckArg;
    const requestResult = {
        setDisableHeaderCheck(value) {
            disableHeaderCheckArg = value;
        },
    };
    const ioClient = {
        util: {
            request() {
                return requestResult;
            },
        },
    };

    assert.equal(patchSocketIoClientForNode(ioClient), true);
    assert.equal(ioClient.__overleafWorkshopNodeRequestPatched, true);
    assert.equal(ioClient.util.request(), requestResult);
    assert.equal(disableHeaderCheckArg, true);
});

test('patchSocketIoClientForNode only patches a client once', () => {
    const ioClient = {
        util: {
            request() {
                return {};
            },
        },
    };

    assert.equal(patchSocketIoClientForNode(ioClient), true);
    const patchedRequest = ioClient.util.request;
    assert.equal(patchSocketIoClientForNode(ioClient), false);
    assert.equal(ioClient.util.request, patchedRequest);
});
