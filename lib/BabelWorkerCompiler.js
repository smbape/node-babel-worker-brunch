const Module = require("module");
const sysPath = require("path");
const fs = require("fs");
const {fork, spawn} = require("child_process");

const anymatch = require("anymatch");
const stripJsonComments = require("strip-json-comments");
const defaults = require("lodash/defaults");
const semLib = require("sem-lib");

const hasProp = Object.prototype.hasOwnProperty;

const argv = process.execArgv.join();
const isDebug = argv.includes("--inspect") || argv.includes("--debug");

const relativeModules = {};

const resolve = (loc, relative) => {
    if (relative == null) {
        relative = process.cwd();
    }

    let relativeMod = relativeModules[relative];

    if (!relativeMod) {
        relativeMod = new Module();

        const filename = sysPath.join(relative, ".babelrc");
        relativeMod.id = filename;
        relativeMod.filename = filename;

        relativeMod.paths = Module._nodeModulePaths(relative);
        relativeModules[relative] = relativeMod;
    }

    try {
        return Module._resolveFilename(loc, relativeMod);
    } catch ( err ) {
        return null;
    }
};

const babel = require(resolve("@babel/core") || resolve("babel-core"));
const isVersion6 = babel.version.startsWith("6.");

// https://babeljs.io/docs/en/options#name-normalization
const babelResolve = (type, name) => {
    if (isVersion6) {
        return resolve(`babel-${ type }-${ name }`) || resolve(`${ type }-${ name }`) || resolve(`babel-${ name }`) || resolve(name) || name;
    }

    // Absolute paths pass through untouched.
    // Relative paths starting with ./ pass through untouched.
    // References to files within a package are untouched.
    if (name.startsWith("./") || name.startsWith(".\\") || /\.[^.]+$/.test(name) || sysPath.isAbsolute(name)) {
        return resolve(name) || name;
    }

    // Any identifier prefixed with module: will have the prefix removed but otherwise be untouched.
    if (name.startsWith("module:")) {
        return resolve(name.slice("module:".length)) || resolve(name) || name;
    }

    // plugin-/preset- will be injected at the start of any @babel-scoped package that doesn't have it as a prefix.
    if (name.startsWith("@babel/")) {
        let normalized = name.slice("@babel/".length);
        if (!normalized.startsWith(`${ type }-`)) {
            normalized = `${ type }-${ normalized }`;
        }
        return resolve(`@babel/${ normalized }`) || name;
    }

    if (name.startsWith("@")) {
        let normalized = name;
        const sep = name.indexOf("/");

        if (sep !== -1) {
            // babel-plugin-/babel-preset- will be injected as a prefix any @-scoped package that doesn't have it anywhere in their name.
            if (name.indexOf(`babel-${ type }-`, sep + 1) === -1) {
                normalized = `${ name.slice(0, sep) }/babel-${ type }-${ name.slice(sep + 1) }`;
            }
        } else {
            // babel-plugin/babel-preset will be injected as the package name if only the @-scope name is given.
            normalized = `${ name }/babel-${ type }`;
        }

        return resolve(normalized) || name;
    }

    // babel-plugin-/babel-preset- will be injected as a prefix any unscoped package that doesn't have it as a prefix.
    let normalized = name;
    if (!normalized.startsWith(`babel-${ type }-`)) {
        normalized = `babel-${ type }-${ normalized }`;
    }

    return resolve(normalized) || name;
};

const resolveOption = (type, options) => {
    if (hasProp.call(options, `${ type }s`)) {
        const config = options[`${ type }s`];
        if (!Array.isArray(config)) {
            return;
        }

        for (let i = 0, len = config.length; i < len; i++) {
            const name = config[i];
            if ("string" === typeof name) {
                config[i] = babelResolve(type, name);
            } else if (Array.isArray(name) && "string" === typeof name[0]) {
                name[0] = babelResolve(type, name[0]);
            }
        }
    }
};

const makeError = error => {
    if (!error) {
        return null;
    }

    const err = new Error(error.message);
    err.stack = error.stack;
    return err;
};

const isNotDebugArg = arg => {
    return arg.indexOf("--inspect") === -1 && arg.indexOf("--debug") === -1;
};

class BabelWorkerCompiler {
    constructor(config) {
        const options = Object.assign({}, config.plugins && config.plugins.babel);
        let hasOptions = false;

        this.options = {};

        Object.keys(options).forEach(key => {
            if (key === "sourceMap" || key === "sourceMaps" || key === "ignore" || key === "pretransform" || key === "workers") {
                return;
            }
            this.options[key] = options[key];
            hasOptions = true;
        }, this);

        this.options.sourceMaps = Boolean(hasProp.call(options, "sourceMaps") ? options.sourceMaps : config.sourceMaps);

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

        if (!hasOptions || options.babelrc) {
            const filename = sysPath.join(process.cwd(), ".babelrc");

            try {
                const buff = fs.readFileSync(filename);
                this.options = Object.assign({}, this.options, JSON.parse(stripJsonComments(buff.toString())));
                this.babelrc = false;
            } catch ( err ) {
                if (err.code !== "ENOENT") {
                    throw err;
                }
            }
        }

        // fix preset/plugin path resolution
        resolveOption("preset", this.options);
        resolveOption("plugin", this.options);

        this.pretransform = Array.isArray(options.pretransform) ? options.pretransform : null;

        let {workers} = options;

        if (!isNaN(workers) && (workers < 0 || !isFinite(workers))) {
            // -1 for the main process
            // -1 to let the user still be able to use his computer
            workers = require("os").cpus().length - 2;
            if (workers < 1) {
                workers = 1;
            }
        }

        if (this.isWorker || !workers) {
            this.workers = false;
        } else {
            const workerFile = this.options.worker ? this.options.worker : sysPath.resolve(__dirname, "worker.js");

            // This is intented
            // workers are shared accross instances
            // otherwise they will be created for every instances
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
                stdio: ["inherit", "inherit", "inherit", "ipc"],
                env: process.env
            };

            let cp, command;
            let parameters = [];
            if (isDebug) {
                cp = spawn;
                command = process.execPath;

                // Remove the debug switches since
                // this might cause fork failed due to debug port already in used
                parameters = process.execArgv.filter(isNotDebugArg).concat([workerFile], parameters);

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
            }

            for (let i = start; i < workers; i++) {
                BabelWorkerCompiler.prototype.workers[i] = cp(command, parameters, spawnOptions);
            }
        }
    }

    compile(params, callback) {
        const {path, data} = params;
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
            const {error, data: result} = this.internal_compile(...args);
            callback(makeError(error), result);
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

                callback(makeError(message.error), result);
            };

            worker.on("error", handlerError);
            worker.on("message", handleMessage);

            worker.send(JSON.stringify(args));
        });
    }

    killWorkers() {
        if (this.workers && this.workers.length !== 0) {
            this.workers.forEach(child => {
                child.kill();
            });
            this.workers.length = 0;
        }
    }

    teardown() {
        this.killWorkers();
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

        return {
            data: result
        };
    }
}

Object.assign(BabelWorkerCompiler.prototype, {
    brunchPlugin: true,
    type: "javascript",
    completer: true,
});

BabelWorkerCompiler.brunchPluginName = "babel-brunch";

module.exports = BabelWorkerCompiler;
