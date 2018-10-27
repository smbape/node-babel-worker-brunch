const BabelWorkerCompiler = require("./BabelWorkerCompiler");

process.on("message", args => {
    args = JSON.parse(args);
    const result = BabelWorkerCompiler.prototype.internal_compile.apply(null, args);
    process.send(JSON.stringify(result));
});

// Keep worker alive
setInterval(Function.prototype, 3600 * 1000);
