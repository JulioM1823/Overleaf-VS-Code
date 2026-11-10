const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validateExternalLinkedFileUrl,
} = require('../out/core/linkedFileUrlPolicy.js');

test('validateExternalLinkedFileUrl accepts public HTTPS URLs and strips fragments', () => {
    const validation = validateExternalLinkedFileUrl(' https://example.com/assets/my%20file.png?download=1#preview ');

    assert.equal(validation.ok, true);
    assert.equal(validation.normalizedUrl, 'https://example.com/assets/my%20file.png?download=1');
    assert.equal(validation.suggestedFileName, 'my file.png');
});

test('validateExternalLinkedFileUrl rejects unsupported protocols and ports', () => {
    assert.deepEqual(validateExternalLinkedFileUrl('http://example.com/file.png'), {
        ok: false,
        issue: 'unsupported-protocol',
    });
    assert.deepEqual(validateExternalLinkedFileUrl('ftp://example.com/file.png'), {
        ok: false,
        issue: 'unsupported-protocol',
    });
    assert.deepEqual(validateExternalLinkedFileUrl('https://example.com:8443/file.png'), {
        ok: false,
        issue: 'unsupported-port',
    });
});

test('validateExternalLinkedFileUrl rejects private and internal hosts', () => {
    for (const url of [
        'https://localhost/file.png',
        'https://127.0.0.1/file.png',
        'https://10.0.0.4/file.png',
        'https://172.16.0.4/file.png',
        'https://192.168.1.4/file.png',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/file.png',
        'https://[fd00::1]/file.png',
        'https://intranet/file.png',
        'https://service.local/file.png',
    ]) {
        const validation = validateExternalLinkedFileUrl(url);
        assert.equal(validation.ok, false, url);
        assert.match(validation.issue, /^(private-host|internal-host)$/);
    }
});

test('validateExternalLinkedFileUrl rejects credential-bearing URLs', () => {
    for (const url of [
        'https://user:password@example.com/file.png',
        'https://example.com/file.png?X-Amz-Signature=abc',
        'https://example.com/file.png?access_token=abc',
        'https://example.com/file.png?sig=abc',
        'https://example.com/file.png?private_key=abc',
    ]) {
        const validation = validateExternalLinkedFileUrl(url);
        assert.equal(validation.ok, false, url);
        assert.match(validation.issue, /^(embedded-credentials|credential-query)$/);
    }
});
