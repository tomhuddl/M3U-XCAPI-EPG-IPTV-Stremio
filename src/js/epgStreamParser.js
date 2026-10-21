'use strict';

const sax = require('sax');

const MAX_PROGRAMMES_PER_SOURCE = 150000;
const MAX_EPG_BYTES = 800 * 1024 * 1024;
// Bound retained free text: one malformed programme must not consume the
// process heap even when the overall XML feed is within its byte limit.
const MAX_TITLE_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 8192;

/**
 * Parse XMLTV from a Node readable stream. XML bytes are consumed incrementally;
 * only programme records for channel IDs used by the playlist are retained.
 */
function parseEPGStream(readable, allowedChannelIds) {
    return new Promise((resolve, reject) => {
        const allowed = allowedChannelIds instanceof Set ? allowedChannelIds : null;
        const epgData = Object.create(null);
        let current = null;
        let field = null;
        let programmeCount = 0;
        let bytesRead = 0;
        let settled = false;
        const xml = sax.createStream(true, { trim: false, normalize: false });

        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(epgData);
        };

        xml.on('opentag', (tag) => {
            const name = tag.name.toLowerCase();
            if (name === 'programme') {
                const attrs = tag.attributes || {};
                const channel = attrs.channel;
                current = channel && (!allowed || allowed.has(String(channel)))
                    ? {
                        channel: String(channel),
                        start: attrs.start || '',
                        stop: attrs.stop || '',
                        title: '',
                        desc: '',
                        keep: true
                    }
                    : { keep: false };
                field = null;
                return;
            }
            if (current && current.keep && (name === 'title' || name === 'desc')) {
                if (name === 'title' && current.hasTitle) return;
                if (name === 'desc' && current.hasDesc) return;
                if (name === 'title') current.hasTitle = true;
                else current.hasDesc = true;
                field = name;
            }
        });

        xml.on('text', (value) => {
            if (current && current.keep && field) {
                if (field === 'title') current.title = (current.title + value).slice(0, MAX_TITLE_CHARS);
                else if (current.desc.length < MAX_DESCRIPTION_CHARS) current.desc = (current.desc + value).slice(0, MAX_DESCRIPTION_CHARS);
            }
        });
        xml.on('cdata', (value) => {
            if (current && current.keep && field) {
                if (field === 'title') current.title = (current.title + value).slice(0, MAX_TITLE_CHARS);
                else if (current.desc.length < MAX_DESCRIPTION_CHARS) current.desc = (current.desc + value).slice(0, MAX_DESCRIPTION_CHARS);
            }
        });
        xml.on('closetag', (tagName) => {
            const name = String(tagName).toLowerCase();
            if ((name === 'title' || name === 'desc') && field === name) {
                field = null;
            }
            if (name !== 'programme' || !current) return;
            if (current.keep && current.start && current.stop) {
                programmeCount += 1;
                if (programmeCount > MAX_PROGRAMMES_PER_SOURCE) {
                    finish(new Error('EPG source exceeds the 150,000 retained-programme safety limit'));
                    readable.destroy();
                    return;
                }
                if (!epgData[current.channel]) epgData[current.channel] = [];
                epgData[current.channel].push({
                    start: current.start,
                    stop: current.stop,
                    title: (current.title || 'Unknown').trim(),
                    desc: (current.desc || '').trim()
                });
            }
            current = null;
            field = null;
        });

        xml.on('error', (error) => {
            if (readable && typeof readable.destroy === 'function') readable.destroy();
            finish(new Error('Invalid XMLTV data: ' + error.message));
        });
        xml.on('end', () => finish());
        readable.on('data', (chunk) => {
            bytesRead += chunk.length;
            if (bytesRead > MAX_EPG_BYTES) {
                finish(new Error('EPG source exceeds the 800 MB streaming limit'));
                readable.destroy();
            }
        });
        readable.on('error', finish);
        readable.pipe(xml);
    });
}

module.exports = { parseEPGStream, MAX_PROGRAMMES_PER_SOURCE, MAX_EPG_BYTES, MAX_TITLE_CHARS, MAX_DESCRIPTION_CHARS };
