const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const markerName = '.orbitleaf-hosted-audit-owner.json';
const markerKind = 'orbitleaf-hosted-audit-profile-v1';

function ownedLocation(profile, temporaryRoot = os.tmpdir()) {
    assert(typeof profile==='string' && path.isAbsolute(profile), 'Audit profile path must be absolute');
    const stat = fs.lstatSync(profile);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Audit profile must be a real directory');
    const real = fs.realpathSync(profile);
    const relative = path.relative(fs.realpathSync(temporaryRoot), real);
    assert(relative && !path.isAbsolute(relative) && !relative.includes(path.sep)
        && relative.startsWith('orbitleaf-hosted-audit-'), 'Audit profile must be an owned direct child of the OS temporary directory');
    if (process.platform!=='win32') {
        assert.equal(stat.mode & 0o077, 0, 'Audit profile must remain private');
        assert.equal(stat.uid, process.getuid(), 'Audit profile must belong to the current user');
    }
    for (const child of ['user', 'extensions']) {
        const filename = path.join(real, child);
        try {
            const childStat = fs.lstatSync(filename);
            assert(childStat.isDirectory() && !childStat.isSymbolicLink(), 'Audit profile directories cannot be aliases');
        } catch (error) {
            if (error.code!=='ENOENT') { throw error; }
        }
    }
    return real;
}

function createOwnedProfile(temporaryRoot = os.tmpdir()) {
    const profile = fs.mkdtempSync(path.join(temporaryRoot, 'orbitleaf-hosted-audit-'));
    fs.chmodSync(profile, 0o700);
    const real = ownedLocation(profile, temporaryRoot);
    const profileOwnershipToken = randomUUID();
    fs.writeFileSync(path.join(real, markerName), JSON.stringify({kind: markerKind, profile: real, profileOwnershipToken}), {mode: 0o600, flag: 'wx'});
    return {profile: real, profileOwnershipToken};
}

function resumeOwnedProfile(metadata, temporaryRoot = os.tmpdir()) {
    assert(metadata?.normalDevelopmentHost===true && metadata.credentialsCopied===false, 'Only a prior isolated audit launch can resume');
    const profile = ownedLocation(metadata.profile, temporaryRoot);
    assert.equal(metadata.profile, profile, 'Launch metadata must identify the exact canonical audit profile');
    const filename = path.join(profile, markerName);
    const stat = fs.lstatSync(filename);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size<=2048, 'Audit ownership marker must be a small regular file');
    const marker = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(marker.kind, markerKind, 'Audit ownership marker is required');
    assert.equal(marker.profile, profile, 'Audit ownership marker must identify this profile');
    assert(typeof metadata.profileOwnershipToken==='string' && /^[a-f0-9-]{36}$/i.test(metadata.profileOwnershipToken), 'Audit ownership token is required');
    assert.equal(marker.profileOwnershipToken, metadata.profileOwnershipToken, 'Launch metadata and ownership marker must match');
    return {profile, profileOwnershipToken: marker.profileOwnershipToken};
}

function launchProfilePath(profile, temporaryRoot = os.tmpdir()) {
    const canonical = ownedLocation(profile, temporaryRoot);
    // macOS's OS temporary path can be a shorter alias of /private/var/... .
    // Keep its verified spelling for Electron's limited-length Unix socket.
    const launchPath = path.join(temporaryRoot, path.basename(canonical));
    assert.equal(fs.realpathSync(launchPath), canonical, 'Launch spelling must resolve to the same owned audit profile');
    return launchPath;
}

module.exports = {createOwnedProfile, resumeOwnedProfile, launchProfilePath};
