const {StorageOwnership} = require('../../out/utils/storageOwnership');
(async () => {
    try {
        const guard = await StorageOwnership.acquire(process.argv[2]);
        process.send({status: 'acquired'});
        await new Promise(resolve => process.once('message', resolve));
        await guard.release();
        process.send({status: 'released'});
    } catch (error) { process.send({status: 'blocked', message: error.message}); }
    process.disconnect();
})().catch(error => { console.error(error); process.exitCode = 1; });
