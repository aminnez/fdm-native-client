"use strict";

const config = require("./config.js");

// closing node when parent process is killed
process.stdin.resume();
process.stdin.on("end", () => process.exit());

function parseCommandLine(cmdStr) {
  const parsedArgs = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && process.platform !== "win32") {
      if (inSingleQuote) {
        current += char;
      } else {
        escaped = true;
      }
      continue;
    }

    if (char === '"') {
      if (inSingleQuote) {
        current += char;
      } else {
        inDoubleQuote = !inDoubleQuote;
      }
      continue;
    }

    if (char === "'") {
      if (inDoubleQuote) {
        current += char;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (char === " " || char === "\t") {
      if (inDoubleQuote || inSingleQuote) {
        current += char;
      } else {
        if (current) {
          parsedArgs.push(current);
          current = "";
        }
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parsedArgs.push(current);
  }

  return parsedArgs;
}

function wrapChildProcess(cp) {
  return new Proxy(cp, {
    get(target, prop, receiver) {
      if (prop === "spawn") {
        return function (command, args, options) {
          const parts = parseCommandLine(command);
          if (parts.length > 1) {
            const finalCommand = parts[0];
            const finalArgs = parts.slice(1).concat(args || []);
            return target.spawn(finalCommand, finalArgs, options);
          }
          return target.spawn(command, args, options);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") {
        return val.bind(target);
      }
      return val;
    },
  });
}

function observe(request, push, done) {
  let close;
  const exception = (e) => {
    push({
      code: -1,
      type: "exception",
      error: e.stack,
    });
    close();
  };
  close = () => {
    process.removeListener("uncaughtException", exception);
    done();
    close = () => {};
  };
  process.addListener("uncaughtException", exception);

  if (request.method === "spec") {
    push({
      version: config.version,
      env: process.env,
      release: process.release,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      separator: require("path").sep,
      tmpdir: require("os").tmpdir(),
    });
    close();
  } else if ("script" in request) {
    const vm = require("vm");
    const sandbox = {
      version: config.version,
      env: process.env,
      push,
      close,
      setTimeout,
      args: request.args,
      // only allow internal modules that extension already requested permission for
      require: (name) => {
        if ((request.permissions || []).indexOf(name) === -1) {
          return null;
        }
        const mod = require(name);
        if (name === "child_process") {
          return wrapChildProcess(mod);
        }
        return mod;
      },
    };
    const script = new vm.Script(request.script);
    const context = new vm.createContext(sandbox);
    script.runInContext(context);
  } else {
    push({
      type: "context",
      error: 'cannot find "script" key in your request. Closing connection...',
    });
    close();
  }
}
/* message passing */
const nativeMessage = require("./messaging");
process.stdin
  .pipe(new nativeMessage.Input())
  .pipe(new nativeMessage.Transform(observe))
  .pipe(new nativeMessage.Output())
  .pipe(process.stdout);
