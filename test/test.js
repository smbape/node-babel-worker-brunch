/* eslint-env mocha */

const {assert} = require("chai");
const BabelWorkerCompiler = require("../");

const presetEnv = [
    "@babel/preset-env", {
        targets: {
            ie: "11"
        },

        exclude: [
            "@babel/plugin-transform-typeof-symbol"
        ],

        modules: false
    }
];

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
        const content = "let c = {};\nlet { a, b } = c;";

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
            assert.include(result.data.replace(/\s/g, ""), content.replace(/\s/g, ""));
            done();
        });
    });

    it("should compile and produce valid result", function(done) {
        this.timeout(20000); // eslint-disable-line no-invalid-this
        const content = "let c = {};\nlet {a, b} = c;";
        const expected = "var a = c.a,\n    b = c.b;";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    presets: [presetEnv]
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
        const content = "let c = {};\nlet {a, b} = c;";
        const expected = "var a = c.a,\n    b = c.b;";

        BabelWorkerCompiler.prototype.killWorkers();
        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    workers: 1,
                    presets: [presetEnv],
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
        process.env.NODE_ENV = "development";
        const content = "let c = () => process.env.NODE_ENV;";
        const expected = "var c = function c() {\n  return \"development\";\n};";

        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    presets: [presetEnv],
                    plugins: ["module:babel-plugin-transform-node-env-inline"]
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
        process.env.NODE_ENV = "development";
        const content = "var c = () => process.env.NODE_ENV;";
        const expected = "var c = function c() {\n  return \"development\";\n};";

        BabelWorkerCompiler.prototype.killWorkers();
        const plugin = new BabelWorkerCompiler({
            plugins: {
                babel: {
                    workers: 1,
                    presets: [presetEnv],
                    plugins: ["module:babel-plugin-transform-node-env-inline"]
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
