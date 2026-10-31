"use strict";
const { AsyncLocalStorage } = require("async_hooks");
const storage = new AsyncLocalStorage();
exports.current = () => storage.getStore() || {};
exports.run = (context, fn) => storage.run(context, fn);
exports.background = fn => storage.run({ priority: "background" }, fn);

