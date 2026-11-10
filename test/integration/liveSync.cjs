const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const root = path.resolve(__dirname, '../..');
const {GlobalStateManager} = require(path.join(root, 'out/utils/globalStateManager'));
const {mergeTextFromCommonBase} = require(path.join(root, 'out/core/threeWayMerge'));
const {getManagedDocumentState} = require(path.join(root, 'out/core/liveTextDocumentRegistry'));
const {SocketIOAlt} = require(path.join(root, 'out/api/socketioAlt'));

exports.run = async () => {
    const extension = vscode.extensions.getExtension(`${require(path.join(root, 'package.json')).publisher}.${require(path.join(root, 'package.json')).name}`);
    assert(extension, 'Development extension should be present');
    assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(root), 'Must test the current workspace build');
    await extension.activate();
    if (process.env.OVERLEAF_TEST_LOGIN_UI === '1' && process.env.OVERLEAF_TEST_PHASE !== 'restart') {
        console.log('Sign in through the masked cookie input; credentials remain in VS Code SecretStorage.');
        await vscode.commands.executeCommand('overleaf-workshop.projectManager.loginServer');
    }
    const projectId = process.env.OVERLEAF_TEST_PROJECT;
    const userId = process.env.OVERLEAF_TEST_USER;
    const server = process.env.OVERLEAF_TEST_SERVER;
    const projectName = process.env.OVERLEAF_TEST_PROJECT_NAME;
    assert(projectName?.startsWith('Overleaf Workshop Reliability Audit '), 'Only disposable audit projects are allowed');
    const projectUri = vscode.Uri.from({scheme: 'overleaf-workshop', authority: server,
        path: `/${projectName}`, query: new URLSearchParams({user: userId, project: projectId}).toString()});
    const vfs = await vscode.commands.executeCommand('remoteFileSystem.prefetch', projectUri);
    const effects = [];
    let second;
    let alternative;
    const started = Date.now();
    async function waitFor(predicate, label) {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (await predicate()) { return; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out: ${label}`);
    }
    try {
        const project = await vfs.init({autoCompileAfterInitialization: false});
        assert.equal(project.name, projectName);
        assert(!vfs.socket.isUsingAlternativeConnectionScheme, 'Live test needs realtime transport');
        const uri = vfs.pathToUri('/main.tex');
        const session = await vfs.ensureTextDocumentSession(uri);
        const docId = session.docId;
        if (process.env.OVERLEAF_TEST_PHASE === 'restart') {
            assert(session.localText.includes('% alternative-only draft'), 'Pending draft must survive extension-host restart');
            assert(session.remoteText.includes('% collaborator during alternative upload'), 'Server edit must survive restart');
            assert(!session.remoteText.includes('% alternative-only draft'), 'Restart must not silently overwrite the original');
            for (let index = 0; index < 3; index++) {
                assert(session.localText.includes(`% editor-disconnect-${index}`), 'Disconnected editor typing remains retained');
            }
            const report = JSON.parse(fs.readFileSync(process.env.OVERLEAF_LIVE_REPORT, 'utf8'));
            report.effects.push({scenario: 'extension-host-restart-with-pending-draft', passed: true,
                recoveryRequired: !!session.recoveryRequired});
            report.restartElapsedMs = Date.now() - started;
            fs.writeFileSync(process.env.OVERLEAF_LIVE_REPORT, JSON.stringify(report, null, 2), {mode: 0o600});
            return;
        }
        const secondRuntime = await GlobalStateManager.initSocketIOAPI(vfs.context, server, projectId, userId);
        assert(secondRuntime, 'Existing credentials should be available through SecretStorage');
        second = secondRuntime.socket;
        // Reuse the target resolved from this project's page, including load balancer routing.
        second.socketConnectionTarget = {...vfs.socket.socketConnectionTarget};
        await second.prepareForJoin();
        await second.joinProject(projectId);
        await second.joinDoc(docId);
        assert(vfs.socket.isConnected && second.isConnected);
        effects.push({scenario: 'two-live-clients', passed: true, distinctAccounts: false});

        // Only synthetic content in the newly created project may be changed.
        const baseline = '\\documentclass{article}\n\\begin{document}\nAudit synthetic baseline.\n\\end{document}\n';
        const initial = await vfs.pushTextDocumentChanges(uri, baseline, 'live_audit_initial');
        assert.equal(initial.kind, 'applied');
        await waitFor(async () => (await second.joinDoc(docId)).docLines.join('\n') === baseline, 'baseline on second client');
        effects.push({scenario: 'committed-acknowledgement', passed: true});

        // Simultaneous same-revision edits must converge or be retained as an explicit conflict.
        const state = await second.joinDoc(docId);
        const remoteMarker = '% remote concurrent marker\n';
        const localMarker = '% local concurrent marker\n';
        const results = await Promise.allSettled([
            vfs.pushTextDocumentChanges(uri, baseline + localMarker, 'live_audit_concurrent'),
            second.applyOtUpdate(docId, {doc: docId, v: state.version, op: [{p: 0, i: remoteMarker}]}),
        ]);
        await vfs.refreshTextDocumentSessionFromServer(uri, 'live_audit_concurrent_rejoin',
            {localTextOverride: baseline + localMarker});
        const concurrent = await vfs.ensureTextDocumentSession(uri);
        assert(concurrent.localText.includes(localMarker), 'Local concurrent edit must be retained');
        assert(concurrent.remoteText.includes(remoteMarker), 'Remote concurrent edit must be retained');
        const merged = mergeTextFromCommonBase(baseline, concurrent.localText, concurrent.remoteText);
        if (!concurrent.recoveryRequired) {
            assert.equal(merged.kind, 'merged');
            const resolved = await vfs.pushTextDocumentChanges(uri, concurrent.localText, 'live_audit_merged');
            assert(['applied', 'noop'].includes(resolved.kind));
        }
        effects.push({scenario: 'simultaneous-edits', passed: true,
            outcomes: results.map(result => result.status), recoveryRequired: !!concurrent.recoveryRequired});

        // Disconnect after the server commits but before the sender consumes confirmation.
        await vfs.refreshTextDocumentSessionFromServer(uri, 'live_audit_before_drop');
        const beforeDrop = await vfs.ensureTextDocumentSession(uri);
        if (beforeDrop.recoveryRequired) { throw new Error('Concurrent edits need explicit resolution before drop test'); }
        const draft = beforeDrop.localText + '% committed with lost confirmation\n';
        const transport = vfs.socket.socket;
        const on = transport.on.bind(transport);
        const remove = transport.removeListener.bind(transport);
        const wrappers = new Map();
        transport.on = (event, listener) => {
            if (event !== 'otUpdateApplied') { return on(event, listener); }
            const wrapped = incoming => {
                if (incoming.doc === docId && incoming.op === undefined) { transport.disconnect(); }
                else { listener(incoming); }
            };
            wrappers.set(listener, wrapped);
            return on(event, wrapped);
        };
        transport.removeListener = (event, listener) => remove(event, wrappers.get(listener) || listener);
        const dropped = await vfs.pushTextDocumentChanges(uri, draft, 'live_audit_lost_confirmation');
        transport.on = on; transport.removeListener = remove;
        assert.notEqual(dropped.kind, 'applied');
        await vfs.persistTextDocumentDraft(uri, draft + '% typing while disconnected\n', beforeDrop.remoteText);
        await vfs.requestRealtimeRecovery('document_version_mismatch');
        await waitFor(() => vfs.socket.isConnected, 'reconnected transport');
        const recovered = await vfs.refreshTextDocumentSessionFromServer(uri, 'live_audit_reconnected',
            {localTextOverride: draft + '% typing while disconnected\n'});
        assert(recovered.localText.includes('% typing while disconnected'), 'Offline typing must survive reconnect');
        assert(recovered.remoteText.includes('% committed with lost confirmation'), 'Committed update must be observed on rejoin');
        effects.push({scenario: 'lost-confirmation-and-reconnect', passed: true, unconfirmedOutcome: dropped.kind,
            recoveryRequired: !!recovered.recoveryRequired});

        const settled = await vfs.pushTextDocumentChanges(uri, recovered.localText, 'live_audit_after_reconnect');
        assert(['applied', 'noop'].includes(settled.kind));
        // Exercise VS Code's real document events and production debounce,
        // rather than submitting every edit directly through the VFS.
        const editorDocument = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(editorDocument);
        await waitFor(() => getManagedDocumentState(uri) === 'live', 'editor session attached');
        for (let index = 0; index < 30; index++) {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(uri, editorDocument.positionAt(editorDocument.getText().length), `% editor-burst-${index}\n`);
            assert(await vscode.workspace.applyEdit(edit));
        }
        const editorDraft = editorDocument.getText();
        await waitFor(async () => (await second.joinDoc(docId)).docLines.join('\n') === editorDraft, 'editor burst reached server');
        const editorRemote = '% editor remote update\n';
        const editorState = await second.joinDoc(docId);
        await second.applyOtUpdate(docId, {doc: docId, v: editorState.version, op: [{p: 0, i: editorRemote}]});
        await waitFor(() => editorDocument.getText() === editorRemote + editorDraft, 'remote edit reached actual editor');
        effects.push({scenario: 'real-editor-burst-and-remote-edit', passed: true, edits: 30});
        for (let index = 0; index < 3; index++) {
            vfs.socket.socket.disconnect();
            const edit = new vscode.WorkspaceEdit();
            const marker = `% editor-disconnect-${index}\n`;
            edit.insert(uri, editorDocument.positionAt(editorDocument.getText().length), marker);
            assert(await vscode.workspace.applyEdit(edit));
            await vfs.requestRealtimeRecovery('document_version_mismatch');
            await waitFor(() => vfs.socket.isConnected && getManagedDocumentState(uri) === 'live', 'editor reconnect');
            await waitFor(async () => (await second.joinDoc(docId)).docLines.join('\n') === editorDocument.getText(), 'disconnected editor typing committed');
            assert(editorDocument.getText().includes(marker));
        }
        effects.push({scenario: 'real-editor-repeated-reconnect', passed: true, reconnects: 3});
        assert(await editorDocument.save());
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        // The copy option must preserve a real collaborator edit that occurs
        // between reading the draft and HTTP upload. Only this disposable project is used.
        const originalBeforeCopy = (await second.joinDoc(docId)).docLines.join('\n');
        const copyDraft = originalBeforeCopy + '% alternative-only draft\n';
        await vfs.persistTextDocumentDraft(uri, copyDraft, originalBeforeCopy);
        const resolved = await vfs._resolveUri(uri);
        resolved.fileEntity.localCache = copyDraft;
        let copyEntity;
        let uploadedText;
        const api = Object.create(vfs.api);
        const originalUpload = vfs.api.uploadFile.bind(vfs.api);
        api.uploadFile = async (...args) => {
            uploadedText = Buffer.from(args[4]).toString();
            const state = await second.joinDoc(docId);
            await second.applyOtUpdate(docId, {doc: docId, v: state.version, op: [{p: 0, i: '% collaborator during alternative upload\n'}]});
            return originalUpload(...args);
        };
        alternative = new SocketIOAlt(projectUri.toString(), api, vfs.socket.currentIdentity, projectId, Promise.resolve(project));
        alternative._vfs = vfs;
        alternative.vfsRefreshTask.stop();
        await alternative.stageDocument(docId);
        alternative.on('reciveNewDoc', (_folder, entity) => { copyEntity = entity; });
        console.log('Choose Upload recovery copies in the alternative-mode confirmation.');
        await alternative.uploadToVFS();
        assert(copyEntity, 'Recovery copy should be confirmed by Overleaf');
        assert.notEqual(copyEntity.name, 'main.tex');
        assert.equal(alternative.unSyncedChanges, 1, 'Original remains pending');
        assert.equal(uploadedText, copyDraft);
        const originalAfterCopy = (await second.joinDoc(docId)).docLines.join('\n');
        assert(originalAfterCopy.includes('% collaborator during alternative upload'));
        assert(!originalAfterCopy.includes('% alternative-only draft'));
        const copy = await second.joinDoc(copyEntity._id);
        assert.equal(copy.docLines.join('\n'), copyDraft);
        effects.push({scenario: 'alternative-recovery-copy-with-concurrent-edit', passed: true,
            originalsPreserved: true, draftRemainsPending: true});
        const report = {status: 'passed', vscode: vscode.version, extensionPathVerified: true,
            elapsedMs: Date.now() - started, effects,
            limitation: 'Two real server clients use one existing account; separate-account authorization still needs a second test account.'};
        fs.mkdirSync(path.dirname(process.env.OVERLEAF_LIVE_REPORT), {recursive: true});
        fs.writeFileSync(process.env.OVERLEAF_LIVE_REPORT, JSON.stringify(report, null, 2), {mode: 0o600});
        console.log(JSON.stringify(report));
    } catch (error) {
        fs.mkdirSync(path.dirname(process.env.OVERLEAF_LIVE_REPORT), {recursive: true});
        fs.writeFileSync(process.env.OVERLEAF_LIVE_REPORT,
            JSON.stringify({status: 'failed', effects, reason: error instanceof Error ? error.message : 'Live test failure'}, null, 2), {mode: 0o600});
        throw error;
    } finally {
        alternative?.disconnect();
        second?.disconnect();
        vfs.dispose();
    }
};
