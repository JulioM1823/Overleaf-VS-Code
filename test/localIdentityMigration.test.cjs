const {test} = require('node:test');
const assert = require('node:assert/strict');
const {transferState} = require('../scripts/migrate-local-identity.cjs');
function context(id, entries = {}) {
 const state = new Map(Object.entries(entries)), secrets = new Map();
 return {extension: {id}, globalStorageUri: id, state, secretMap: secrets,
  globalState: {keys: () => [...state.keys()], get: key => state.get(key), update: async (k,v) => state.set(k,v)},
  secrets: {get: async k => secrets.get(k), store: async (k,v) => secrets.set(k,v)}};
}
const fsApi = {workspace: {fs: {readDirectory: async () => [], createDirectory: async () => {}}}};
test('local identity migration copies only referenced Overleaf sessions, preserving source', async () => {
 const key = 'overleaf-workshop.serverIdentity.test.session';
 const source = context('iamhyc.overleaf-workshop', {'overleaf-servers': {test: {login: {identitySecretKey: key}}}, draft: 'recoverable draft'});
 source.secretMap.set(key, 'synthetic credential'); source.secretMap.set('unrelated', 'excluded');
 const target = context('morales-local-01a0f106.overleaf-workshop');
 const report = await transferState(source, target, fsApi);
 assert.equal(report.credentialsTransferred, 1); assert.deepEqual(target.state, source.state);
 assert.equal(target.secretMap.get(key), source.secretMap.get(key)); assert.equal(target.secretMap.has('unrelated'), false);
 assert.equal(source.secretMap.size, 2); assert.equal(report.sourceRetained, true);
});
test('migration refuses to overwrite an existing destination', async () => {
 const source = context('iamhyc.overleaf-workshop');
 const target = context('morales-local-01a0f106.overleaf-workshop', {draft: 'keep'});
 await assert.rejects(transferState(source, target, fsApi), /refusing to overwrite/);
 assert.equal(target.state.get('draft'), 'keep');
});
test('migration rejects unrelated credential keys without reading them', async () => {
 const source = context('iamhyc.overleaf-workshop', {'overleaf-servers': {test: {login: {identitySecretKey: 'unrelated'}}}});
 source.secrets.get = async () => assert.fail('Must not read unrelated credentials');
 await assert.rejects(transferState(source, context('morales-local-01a0f106.overleaf-workshop'), fsApi), /Unexpected credential key/);
});
test('packaged release identity is separate while command and workspace namespaces remain compatible', () => {
 const pkg = require('../package.json');
 assert.equal(`${pkg.publisher}.${pkg.name}`, 'AstroJulio.orbitleaf');
 assert(pkg.contributes.commands.every(c => c.command.startsWith('overleaf-workshop.')));
 assert(pkg.activationEvents.includes('onFileSystem:overleaf-workshop'));
 assert.deepEqual(require('./integration/live-driver/package.json').extensionDependencies, [`${pkg.publisher}.${pkg.name}`]);
});
