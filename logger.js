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

function emit(level, args, forceDebug = false) {
    if (!isEnabled(level, forceDebug)) return;
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method(`[${level.toUpperCase()}]`, ...args);
}

function logAt(level, ...args) {
    if (!isEnabled(level)) return;
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method(...args);
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
