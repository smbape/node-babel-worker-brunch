/* eslint-env mocha */

"use strict";

const {assert} = require("chai");
const BabelWorkerCompiler = require("../");

describe(BabelWorkerCompiler.brunchPluginName, function() {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    after(() => {
        BabelWorkerCompiler.prototype.teardown();
    });

    it("should be an object", () => {
        const plugin = new BabelWorkerCompiler({});
        assert.isObject(plugin);
    });

    it("should have #compile method", () => {
        const plugin = new BabelWorkerCompiler({});
        assert.equal(typeof plugin.compile, "function");
    });

    it("should do nothing for no preset", done => {
        const content = "var c = {};\nvar { a, b } = c;";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    presets: []
                }
            }
        });

        plugin.compile({
            data: content,
            path: "file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.include(result.data, content);
            done();
        });
    });

    it("should compile and produce valid result", function(done) {
        this.timeout(20000); // eslint-disable-line no-invalid-this
        const content = "var c = {};\nvar {a, b} = c;";
        const expected = "var a = c.a,\n    b = c.b;";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    presets: ["es2015"]
                }
            }
        });

        plugin.compile({
            data: content,
            path: "file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.include(result.data, expected);
            done();
        });
    });

    it("should compile and produce valid result with workers", function(done) {
        this.timeout(20000); // eslint-disable-line no-invalid-this
        const content = "var c = {};\nvar {a, b} = c;";
        const expected = "var a = c.a,\n    b = c.b;";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    workers: 1,
                    presets: ["es2015"],
                }
            }
        });

        assert.isArray(plugin.workers);
        assert.lengthOf(plugin.workers, 1);

        plugin.compile({
            data: content,
            path: "file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.include(result.data, expected);
            done();
        });
    });

    it("should load presets/plugins", done => {
        const content = "var c = () => process.env.NODE_ENV;";
        const expected = "\"use strict\";\n\nvar c = function c() {\n  return undefined;\n};";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    presets: ["es2015"],
                    plugins: ["transform-node-env-inline"]
                }
            }
        });

        plugin.compile({
            data: content,
            path: "file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.include(result.data, expected);
            done();
        });
    });

    it("should load presets/plugins with workers", done => {
        const content = "var c = () => process.env.NODE_ENV;";
        const expected = "\"use strict\";\n\nvar c = function c() {\n  return undefined;\n};";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    workers: 1,
                    presets: ["es2015"],
                    plugins: ["transform-node-env-inline"]
                }
            }
        });

        plugin.compile({
            data: content,
            path: "file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.include(result.data, expected);
            done();
        });
    });

    describe("custom file extensions & patterns", () => {
        const basicPlugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    pattern: /\.(babel|es6|jsx)$/
                }
            }
        });

        const sourceMapPlugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    pattern: /\.(babel|es6|jsx)$/,
                    sourceMaps: true
                }
            }
        });

        const content = "let a = 1";
        const path = "file.es6";

        it("should handle custom file extensions", done => {
            basicPlugin.compile({
                data: content,
                path
            }, (err, result) => {
                assert.ifError(err);
                done();
            });
        });

        it("should properly link to source file in source maps", done => {
            sourceMapPlugin.compile({
                data: content,
                path
            }, (err, result) => {
                assert.ifError(err);
                assert.doesNotThrow(() => {
                    JSON.parse(result.map);
                });
                assert.include(JSON.parse(result.map).sources, path);
                done();
            });
        });
    });


    it("should produce source maps", done => {
        const plugin = new BabelWorkerCompiler({
            sourceMaps: true
        });

        const content = "let a = 1";

        plugin.compile({
            data: content,
            path: "file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.doesNotThrow(() => {
                JSON.parse(result.map);
            });
            done();
        });
    });

    it("should pass through content of ignored paths", done => {
        const content = "Invalid ' code";

        const plugin = new BabelWorkerCompiler({});
        plugin.compile({
            data: content,
            path: "vendor/file.js"
        }, (err, result) => {
            assert.ifError(err);
            assert.equal(content, result.data);
            done();
        });
    });
});
