"use strict";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEBUG_MODE = (process.env.DEBUG_MODE || "").toLowerCase() === "true";
const requestedLevel = (process.env.LOG_LEVEL || "info").trim().toLowerCase();
const minimumLevel = LEVELS[requestedLevel] ?? LEVELS.info;

function isEnabled(level, forceDebug = false) {
    if (forceDebug || DEBUG_MODE) return true;
    return LEVELS[level] >= minimumLevel;
}

function isDebugEnabled(forceDebug = false) {
    return isEnabled("debug", forceDebug);
}

function formatLogArg(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
        return JSON.stringify({ name: value.name, message: value.message });
    }
    if (typeof value === "bigint") return value.toString();
    try {
        const formatted = JSON.stringify(value);
        return formatted === undefined ? String(value) : formatted;
    } catch {
        return "[unserializable]";
    }
}

function writeLog(level, args, prefix = null) {
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    const values = prefix ? [prefix, ...args] : args;
    method(values.map(formatLogArg).join(" "));
}

function emit(level, args, forceDebug = false) {
    if (!isEnabled(level, forceDebug)) return;
    writeLog(level, args, `[${level.toUpperCase()}]`);
}

function logAt(level, ...args) {
    if (!isEnabled(level)) return;
    writeLog(level, args);
}

function createLogger(forceDebug = false) {
    return {
        debug: (...args) => emit("debug", args, forceDebug),
        info: (...args) => emit("info", args, forceDebug),
        warn: (...args) => emit("warn", args, forceDebug),
        error: (...args) => emit("error", args, forceDebug)
    };
}

module.exports = { createLogger, isDebugEnabled, logAt };
