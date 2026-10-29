const cooloff = require('../seriesMetadataCooloff');

module.exports = function isolateSeriesCooloff(options = {}) {
    const instance = cooloff.createSeriesMetadataCooloff(options);
    const original = {};
    for (const key of ['guard', 'record429', 'getState']) {
        original[key] = cooloff[key];
        cooloff[key] = instance[key];
    }
    return () => Object.assign(cooloff, original);
};
