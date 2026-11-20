const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const fetch = require('node-fetch');
const {BaseAPI} = require(path.resolve(__dirname, '../../out/api/base'));

exports.run = async ({vfs, uri, docId, projectId, effects}) => {
    const accounts = JSON.parse(fs.readFileSync(process.env.OVERLEAF_CE_ACCOUNT_FILE, 'utf8'));
    const identity = vfs.socket.currentIdentity;
    const outsider = new BaseAPI(process.env.OVERLEAF_CE_URL);
    const strangerLogin = await outsider.passportLogin(accounts[1].email, accounts[1].password);
    assert.equal(strangerLogin.type, 'success', 'Separate synthetic account must authenticate');
    const denied = await fetch(new URL(`project/${projectId}`, process.env.OVERLEAF_CE_URL), {
        redirect: 'manual', timeout: 30000, headers: {Cookie: strangerLogin.identity.cookies}});
    await denied.text();
    assert([403, 404].includes(denied.status), 'Uninvited independent account must not read owner project');
    effects.push({scenario: 'separate-account-project-access-denied', passed: true, httpStatus: denied.status});

    const invalid = await outsider.cookiesLogin('overleaf.sid=synthetic-invalid-session');
    assert.equal(invalid.type, 'error', 'Invalid session must not authenticate');
    effects.push({scenario: 'invalid-cookie-authentication-rejected', passed: true});

    const text = 'Synthetic CE chat ' + crypto.randomUUID();
    const sent = await vfs.sendMessage(vfs.currentPublicId, text);
    assert(sent.ok, 'Authenticated production chat send must succeed');
    const messages = await vfs.api.getMessages(identity, projectId);
    assert.equal(messages.type, 'success');
    assert(messages.messages.some(message => message.content === text), 'Chat must read back from genuine CE');
    effects.push({scenario: 'authenticated-chat-send-server-readback', passed: true});

    const comment = 'Synthetic CE review ' + crypto.randomUUID();
    const threadId = await vfs.createComment(uri, new vscode.Range(0, 0, 0, 5), comment,
        {startOffset: 0, endOffset: 5, selectedText: '% col'});
    assert(threadId, 'Production VFS must create a comment thread');
    const threads = await vfs.api.getCommentThreads(identity, projectId);
    assert.equal(threads.type, 'success');
    assert(JSON.stringify(threads.commentThreads[threadId]).includes(comment), 'Comment must read back from genuine CE');
    const resolved = await vfs.api.resolveCommentThread(identity, projectId, docId, threadId);
    assert.equal(resolved.type, 'success');
    const reopened = await vfs.api.reopenCommentThread(identity, projectId, docId, threadId);
    assert.equal(reopened.type, 'success');
    const removed = await vfs.api.deleteCommentThread(identity, projectId, docId, threadId);
    assert.equal(removed.type, 'success');
    effects.push({scenario: 'authenticated-comment-create-read-resolve-reopen-delete', passed: true});

    const compiled = await vfs.api.compile(identity, projectId, 'main.tex', false, false);
    assert.equal(compiled.type, 'success');
    assert.equal(compiled.compile.status, 'success', 'Genuine CE TeX compiler must succeed');
    const pdf = compiled.compile.outputFiles.find(file => /\.pdf$/i.test(file.path));
    assert(pdf, 'Compiler must produce a PDF');
    const output = await vfs.api.getFileFromClsi(identity, pdf.url, compiled.compile.compileGroup || 'standard');
    assert.equal(Buffer.from(output.content).subarray(0, 5).toString(), '%PDF-');
    effects.push({scenario: 'authenticated-server-tex-compile-and-pdf-download', passed: true,
        bytes: output.content.length, routingMetadataPresent: new URL(pdf.url).searchParams.has('clsiserverid')});
};
