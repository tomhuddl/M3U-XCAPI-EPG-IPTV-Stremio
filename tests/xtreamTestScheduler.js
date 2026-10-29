const requests = require('../xtreamRequests');

// Provider response fixtures should not wait for production pacing or leave
// a simulated quota response affecting the next independent test.
module.exports = function isolateXtreamScheduler(options = {}) {
    const scheduler = requests.createXtreamRequestScheduler({ minIntervalMs: 0, ...options });
    const original = {};
    for (const key of ['request', 'promote', 'cancel', 'getState']) {
        original[key] = requests[key];
        requests[key] = scheduler[key];
    }
    return () => {
        scheduler.close();
        Object.assign(requests, original);
    };
};
