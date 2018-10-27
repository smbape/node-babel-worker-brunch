"use strict";

const sysPath = require("path");
const fs = require("fs");
const {fork, spawn} = require("child_process");

const babel = require("babel-core");
const anymatch = require("anymatch");
const stripJsonComments = require("strip-json-comments");
const defaults = require("lodash/defaults");
const resolve = require("babel-core/lib/helpers/resolve");
const semLib = require("sem-lib");

const hasProp = Object.prototype.hasOwnProperty;

const argv = process.execArgv.join();
const isDebug = argv.includes("--inspect") || argv.includes("--debug");

const babelResolve = (type, name, dirname) => {
    return resolve(`babel-${ type }-${ name }`, dirname) || resolve(`${ type }-${ name }`, dirname) || resolve(`babel-${ name }`) || resolve(name) || name;
};

const resolveOption = (type, options, dirname) => {
    if (hasProp.call(options, `${ type }s`)) {
        const config = options[`${ type }s`];
        if (!Array.isArray(config)) {
            return;
        }

        for (let i = 0, len = config.length; i < len; i++) {
            const name = config[i];
            if ("string" === typeof name) {
                config[i] = babelResolve(type, name, dirname);
            } else if (Array.isArray(name) && "string" === typeof name[0]) {
                name[0] = babelResolve(type, name[0]);
            }
        }
    }
};

class BabelWorkerCompiler {
    constructor(config) {
        const originalOptions = config.plugins && config.plugins.babel;
        const options = originalOptions || {};
        let hasOptions = false;

        this.options = {};

        Object.keys(options).forEach(function(key) {
            if (key === "sourceMap" || key === "ignore" || key === "pretransform") {
                return;
            }
            this.options[key] = options[key];
            hasOptions = true;
        }, this);

        this.options.sourceMap = Boolean(config.sourceMaps);

        if (options.ignore) {
            this.isIgnored = anymatch(options.ignore);
        } else if (config.conventions && config.conventions.vendor) {
            this.isIgnored = config.conventions.vendor;
        } else {
            this.isIgnored = anymatch(/^(bower_components|vendor)/);
        }

        if (this.options.pattern) {
            this.pattern = this.options.pattern;
            delete this.options.pattern;
        }

        if (Array.isArray(this.options.presets) && this.options.presets.length === 0) {
            delete this.options.presets;
        }

        if (!hasOptions) {
            const filename = sysPath.join(process.cwd(), ".babelrc");

            try {
                const stats = fs.statSync(filename);
                if (stats.isFile()) {
                    const buff = fs.readFileSync(filename);
                    this.options = defaults(JSON.parse(stripJsonComments(buff.toString())), this.options);
                    this.babelrc = false;
                }
            } catch ( err ) {
                if (err.code !== "ENOENT") {
                    throw err;
                }
            }
        }

        // fix preset/plugin path resolution
        const dirname = process.cwd();
        resolveOption("preset", this.options, dirname);
        resolveOption("plugin", this.options, dirname);

        this.pretransform = Array.isArray(options.pretransform) ? options.pretransform : null;

        let {workers} = this.options;
        delete this.options.workers;

        if (!isNaN(workers) && (workers < 0 || !isFinite(workers))) {
            // -1 for the main process
            // -1 to let the user still be able to use his computer
            workers = require("os").cpus().length - 2;
            if (workers < 1) {
                workers = 1;
            }
        }

        if (workers) {
            const workerFile = this.options.worker ? this.options.worker : sysPath.resolve(__dirname, "worker.js");

            // This is intented
            // workers are shared accross instances
            // otherwise there may be too much workers
            const start = BabelWorkerCompiler.prototype.workers ? BabelWorkerCompiler.prototype.workers.length : 0;

            if (start === 0) {
                BabelWorkerCompiler.prototype.workers = new Array(workers);
                BabelWorkerCompiler.prototype.semaphore = semLib.semCreate(workers, true);
            } else if (start < workers) {
                const add = workers - start;
                BabelWorkerCompiler.prototype.workers.length += add;
                BabelWorkerCompiler.prototype.semaphore._capacity += add;
            }

            const spawnOptions = {
                stdio: ["inherit", "inherit", "inherit", "ipc"]
            };

            let cp, command, parameters;
            if (isDebug) {
                cp = spawn;
                command = process.execPath;

                // Remove the debug switches since
                // this might cause fork failed due to debug port already in used
                parameters = process.execArgv.filter(arg => arg.indexOf("--inspect") === -1 && arg.indexOf("--debug") === -1).concat([workerFile]);

                if (process._eval != null) {
                    const index = parameters.lastIndexOf(process._eval);
                    if (index > 0) {
                        // Remove the -e switch to avoid fork bombing ourselves.
                        parameters.splice(index - 1, 2);
                    }
                }
            } else {
                cp = fork;
                command = workerFile;
                parameters = [];
            }

            for (let i = start; i < workers; i++) {
                BabelWorkerCompiler.prototype.workers[i] = cp(command, parameters, spawnOptions);
            }
        }
    }

    compile(params, callback) {
        const { path, data } = params;
        if (this.isIgnored(path)) {
            callback(null, params);
            return;
        }

        const options = defaults({
            filename: path
        }, this.options);

        let compiled, transform, toptions;

        compiled = data;

        if (this.pretransform) {
            for (let i = 0, len = this.pretransform.length; i < len; i++) {
                transform = this.pretransform[i];

                if (Array.isArray(transform)) {
                    toptions = Object.assign({}, options, transform[1]);
                    transform = transform[0];
                } else {
                    toptions = options;
                }

                try {
                    compiled = transform(compiled, toptions);
                } catch ( err ) {
                    // logger.error(err.message, err.stack);
                }
            }
        }

        if (this.babelrc === false) {
            options.babelrc = false;
        }

        const args = [path, compiled, options];

        if (!this.workers || this.workers.length === 0) {
            const {error: err, data: result} = this.internal_compile(...args);
            callback(err, result);
            return;
        }

        this.semaphore.semTake(() => {
            const worker = this.workers.shift();

            const handlerError = err => {
                worker.removeListener("error", handlerError);
                worker.removeListener("message", handleMessage); // eslint-disable-line no-use-before-define

                this.workers.push(worker);
                this.semaphore.semGive();
                callback(err);
            };

            const handleMessage = message => {
                worker.removeListener("error", handlerError);
                worker.removeListener("message", handleMessage);

                message = JSON.parse(message);
                const {data: result} = message;
                this.workers.push(worker);
                this.semaphore.semGive();

                let err;
                if (message.error) {
                    err = new Error(message.error.message);
                    err.stack = message.error.stack;
                }

                callback(err, result);
            };

            worker.on("error", handlerError);
            worker.on("message", handleMessage);

            worker.send(JSON.stringify(args));
        });
    }

    teardown() {
        if (this.workers && this.workers.length !== 0) {
            this.workers.forEach(child => {
                child.kill();
            });
            this.workers.length = 0;
        }
    }

    internal_compile(path, compiled, options) {
        try {
            compiled = babel.transform(compiled, options);
        } catch ( err ) {
            return {
                error: {
                    message: err.message,
                    stack: err.stack
                }
            };
        }

        const result = {
            data: compiled.code || compiled,
            path
        };

        // Concatenation is broken by trailing comments in files, which occur
        // frequently when comment nodes are lost in the AST from babel.
        result.data += "\n";

        if (compiled.map) {
            result.map = JSON.stringify(compiled.map);
        }

        return {data: result};
    }
}

Object.assign(BabelWorkerCompiler.prototype, {
    brunchPlugin: true,
    type: "javascript",
    completer: true,
});

BabelWorkerCompiler.brunchPluginName = "babel-brunch";

module.exports = BabelWorkerCompiler;
