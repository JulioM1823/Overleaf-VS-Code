const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');
const {loadedInstalledModule} = require('./integration/release-driver/loaded-module.cjs');

test('release smoke observes the existing Windows module despite path case differences', () => {
    const active = {filename: 'c:\\users\\runner\\extensions\\astrojulio.orbitleaf-0.16.7\\out\\utils\\globalStateManager.js', exports: {GlobalStateManager: class {}}};
    assert.equal(loadedInstalledModule('C:\\Users\\Runner\\extensions\\astrojulio.orbitleaf-0.16.7', 'out/utils/globalStateManager.js', {active}, 'win32'), active);
});

test('release smoke permits Windows cache aliases only when their exports are identical', () => {
    const exports = {GlobalStateManager: class {}};
    const active = {filename: 'C:\\Extension\\out\\utils\\globalStateManager.js', exports};
    const alias = {filename: 'c:\\extension\\out\\utils\\globalStateManager.js', exports};
    assert.equal(loadedInstalledModule('C:\\Extension', 'out/utils/globalStateManager.js', {active, alias}, 'win32'), active);
});

test('release smoke rejects ambiguous Windows module copies with different exports', () => {
    const active = {filename: 'C:\\Extension\\out\\utils\\globalStateManager.js', exports: {}};
    const duplicate = {filename: 'c:\\extension\\out\\utils\\globalStateManager.js', exports: {}};
    assert.throws(() => loadedInstalledModule('C:\\Extension', 'out/utils/globalStateManager.js', {active, duplicate}, 'win32'), /ambiguous/);
});

test('release smoke requires the installed module to have loaded instead of loading a replacement', () => {
    assert.throws(() => loadedInstalledModule('C:\\Extension', 'out/utils/globalStateManager.js', {}, 'win32'), /already be loaded/);
});

test('release smoke keeps case-sensitive cache identity outside Windows', () => {
    const root = path.resolve('release-extension');
    const active = {filename: path.join(root, 'out/utils/globalStateManager.js'), exports: {}};
    assert.equal(loadedInstalledModule(root, 'out/utils/globalStateManager.js', {active}, 'linux'), active);
    const differentCase = {filename: path.join(root, 'out/utils/GlobalStateManager.js'), exports: {}};
    assert.throws(() => loadedInstalledModule(root, 'out/utils/globalStateManager.js', {differentCase}, 'linux'), /already be loaded/);
});

test('release smoke refuses to observe a module outside the installed extension', () => {
    assert.throws(() => loadedInstalledModule('C:\\Extension', '..\\other\\module.js', {}, 'win32'), /inside the installed extension/);
});
