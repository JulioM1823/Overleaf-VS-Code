const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createOwnedProfile, resumeOwnedProfile, launchProfilePath} = require('../scripts/hosted-audit-profile.cjs');

function fixture(t) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-profile-test-'));
    t.after(() => fs.rmSync(temp, {recursive:true,force:true}));
    const owned = createOwnedProfile(temp);
    const metadata = {...owned,normalDevelopmentHost:true,credentialsCopied:false};
    return {temp,owned,metadata};
}

test('owned hosted profiles resume only through matching private launch metadata',t=>{
    const f=fixture(t);assert.deepEqual(resumeOwnedProfile(f.metadata,f.temp),f.owned);
});

test('an ownership token mismatch or absent marker cannot resume a profile',t=>{
    const f=fixture(t);
    assert.throws(()=>resumeOwnedProfile({...f.metadata,profileOwnershipToken:'11111111-1111-1111-1111-111111111111'},f.temp),/must match/);
    fs.unlinkSync(path.join(f.owned.profile,'.orbitleaf-hosted-audit-owner.json'));
    assert.throws(()=>resumeOwnedProfile(f.metadata,f.temp),/ENOENT/);
});

test('normal personal or outside temporary profiles cannot be selected for resume',t=>{
    const f=fixture(t);const normal=path.join(f.temp,'normal-editor-profile');fs.mkdirSync(normal,{mode:0o700});
    assert.throws(()=>resumeOwnedProfile({...f.metadata,profile:normal},f.temp),/owned direct child/);
    assert.throws(()=>resumeOwnedProfile(f.metadata,path.join(f.owned.profile)),/owned direct child/);
});

test('profile aliases and nested user-directory aliases are rejected',t=>{
    const f=fixture(t);const alias=path.join(f.temp,'orbitleaf-hosted-audit-alias');
    fs.symlinkSync(f.owned.profile,alias,'junction');
    assert.throws(()=>resumeOwnedProfile({...f.metadata,profile:alias},f.temp),/real directory/);
    const outside=path.join(f.temp,'outside');fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(f.owned.profile,'user'),'junction');
    assert.throws(()=>resumeOwnedProfile(f.metadata,f.temp),/cannot be aliases/);
});

test('profile ownership markers must bind the exact profile and isolated launch',t=>{
    const f=fixture(t);
    assert.throws(()=>resumeOwnedProfile({...f.metadata,normalDevelopmentHost:false},f.temp),/prior isolated audit/);
    const marker=path.join(f.owned.profile,'.orbitleaf-hosted-audit-owner.json');
    const data=JSON.parse(fs.readFileSync(marker));data.profile=path.dirname(f.owned.profile);fs.writeFileSync(marker,JSON.stringify(data));
    assert.throws(()=>resumeOwnedProfile(f.metadata,f.temp),/identify this profile/);
});

test('the OS temporary-root spelling can launch the exact canonical owned profile',t=>{
    const f=fixture(t);const alias=path.join(f.temp,'temporary-root-alias');
    fs.symlinkSync(f.temp,alias,'junction');
    const launchPath=launchProfilePath(f.owned.profile,alias);
    assert.notEqual(launchPath,f.owned.profile);
    assert.equal(fs.realpathSync(launchPath),f.owned.profile);
});
