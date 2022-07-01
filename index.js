#! /usr/bin/env node

const { LooseParser } = require("acorn-loose");
const { Parser } = require("acorn");
const jsx = require("acorn-jsx");
const fs = require("fs").promises;
const glob = require("glob");
const path = require("path");
const flow = require("flow-parser");
const { program } = require("@caporal/core");
const colorize = require("json-colorizer");
const packageJson = require("./package.json");
const cliProgress = require("cli-progress");

function globFiles(dir) {
  return new Promise((resolve) => {
    glob("**/*.+(js|jsx|mjs)", { cwd: dir }, (err, files) => {
      Promise.all(
        files.map(async (filename) => {
          const fullPath = path.join(dir, filename);
          const isDir = (await fs.stat(fullPath)).isDirectory();
          if (isDir) return;
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            return { content, filename: fullPath };
          } catch (e) {
            console.log(filename);
            console.log(e);
          }
        })
      )
        .then((contents) => resolve(contents.filter((a) => a)))
        .catch((e) => console.log(e));
    });
  });
}
const exists = (a) => {
  if (!a) return false;
  if (Array.isArray(a) && a.length === 0) return false;
  return true;
};

function walkObject(node, walker, opts) {
  return Object.keys(node)
    .map((key) => {
      if (Array.isArray(node[key])) {
        return node[key].map((element) => walker(element, opts));
      } else {
        return walker(node[key], opts);
      }
    })
    .flat();
}

let maybes = [];

const defaultOpts = {
  leaves: ["Identifier", "Literal", "TemplateElement", "ThisExpression"],
  success: (node) => true,
  maybe: () => false,
};
function treeFilter(node, opts) {
  opts = { ...defaultOpts, ...opts };
  if (!node) {
    return;
  }
  if (node.constructor.name !== "Node") {
    return;
  }
  const { leaves } = opts;
  if (leaves.includes(node.type)) {
    return;
  }

  let val = [];
  if (opts.success(node)) {
    val = node;
  } else if (opts.maybe(node)) {
    maybes.push(node);
  } else {
    val = walkObject(node, treeFilter, opts);
  }
  if (Array.isArray(val)) {
    return val.flat().filter(exists);
  }
  return val;
}

function isFromEnv(node) {
  return node?.init?.type === "Identifier" && node.init.name === "env";
}

function isProcessDotEnv(node) {
  return (
    node?.object?.type === "MemberExpression" &&
    node.object.object?.type === "Identifier" &&
    node.object.object.name === "process" &&
    node.object.property?.type === "Identifier" &&
    node.object.property.name === "env"
  );
}

function isFrom({ propName, objName, tree }) {
  const nodes = treeFilter(tree, {
    success: (node) =>
      node?.init?.type === "Identifier" && node.init.name === objName,
  });
  return !!nodes
    .map((node) => {
      switch (node.type) {
        case "VariableDeclarator":
          return node.id.properties
            .map((prop) => prop.value.name)
            .filter((name) => name === propName);
        default:
          console.error(node);
      }
    })
    .flat().length;
}

function getAST(content) {
  let tree;
  try {
    tree = Parser.extend(jsx()).parse(content, {
      ecmaVersion: 2022,
      sourceType: "module",
      allowHashBang: true,
      locations: true,
    });
  } catch (e) {}
  if (!tree) {
    try {
      tree = LooseParser.parse(content, {
        ecmaVersion: 2022,
        sourceType: "module",
        allowHashBang: true,
        locations: true,
      });
    } catch (e) {}
  }
  if (!tree) {
    try {
      tree = flow.parse(content);
    } catch (e) {}
  }
  return tree;
}

async function getEnvVars(dir, logger) {
  logger.info(`Scanning ${dir}`);
  const contents = await globFiles(dir);
  logger.info(`${contents.length} files found.`);
  const bar = new cliProgress.SingleBar(
    {
      format: "{bar} - {filename}",
      hideCursor: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(contents.length, 0, { filename: "N/A" });
  const allVars = contents
    .map(({ content, filename }) => {
      bar.increment({ filename: path.relative(dir, filename) });
      try {
        const ast = getAST(content);
        if (!ast) {
          logger.warn("Skipping", filename, "- unparsable");
          return;
        }
        const raw = treeFilter(ast, {
          success: (node) =>
            node.type === "MemberExpression" && isProcessDotEnv(node),
          maybe: isFromEnv,
        });
        const nodes = (Array.isArray(raw) ? raw : [raw]).map((node) => {
          node.filename = filename;
          return node;
        });
        if (
          maybes.length &&
          isFrom({ propName: "env", objName: "process", tree: ast })
        ) {
          nodes.push(
            ...maybes
              .map(({ id: { properties } }) => {
                return properties.map((prop) => {
                  return { property: prop.key, filename };
                });
              })
              .flat()
          );
        }
        maybes = [];
        return nodes;
      } catch (e) {
        console.error(filename);
        console.error(e);
      }
    })
    .flat()
    .filter(exists)
    .map((node) => {
      const { loc, filename } = node;
      const answer = {
        type: "EnvironmentVariable",
      };

      if (node?.property?.type === "Identifier") {
        answer.name = node.property.name;
      } else if (node?.property?.type === "Literal") {
        answer.name = node.property.value;
      } else if (node?.property?.type === "MemberExpression") {
        answer.computed = getObjectNotation(node.property);
      } else {
        console.error(node, node.constructor.name);
      }

      Object.assign(answer, {
        filename,
        loc,
      });
      return answer;
    })
    .filter((a) => a);
  bar.stop();
  return allVars.sort((a, b) => {
    const aName = a.computed || a.name;
    const bName = b.computed || b.name;
    if (aName < bName) {
      return -1;
    } else if (aName > bName) {
      return 1;
    } else {
      return 0;
    }
  });
}

function getObjectNotation(node) {
  let note = node.object.name;
  if (node.property.type === "Identifier") {
    note += "." + node.property.name;
  } else if (node.property.type === "MemberExpression") {
    note += "." + getObjectNotation(node.property);
  }
  return note;
}

program
  .name(packageJson.name)
  .version(packageJson.version)
  .argument("<dir>", "Root directory of a project to scan")
  .option("--fmt <fmt>", "The Output Format", {
    default: "json",
    validator: ["json"],
  })
  .option("--output <dest>", "A filename, or stdout or stderr", {
    default: "stdout",
  })
  .action(async ({ logger, args, options }) => {
    logger.colorsEnabled = true;
    const vars = await getEnvVars(path.resolve(args.dir), logger);
    let output;
    if (
      options.fmt === "json" &&
      ["stdout", "stdin"].includes(options.output)
    ) {
      output = colorize(vars, { pretty: true });
    } else if (options.fmt === "json") {
      output = JSON.stringify(vars, null, 2);
    }

    if (options.output === "stdout") {
      console.log(output);
    } else if (options.output === "stderr") {
      console.error(output);
    } else {
      const outfile = path.resolve(options.output);
      await fs.writeFile(outfile, output, "utf8");
      logger.info(`Wrote ${vars.length} records to ${outfile}`);
    }
  });

program.run();
