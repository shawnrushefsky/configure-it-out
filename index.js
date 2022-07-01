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
          return node?.id?.properties
            ?.map((prop) => prop.value.name)
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

function findSymbolDeclaration(memberExpression, tree) {
  const used = new Set();
  const match = treeFilter(tree, {
    success: (node) =>
      (node.type === "VariableDeclarator" &&
        node?.id?.type === "Identifier" &&
        node?.id?.name === memberExpression.object.name) ||
      (memberExpression.object.name === "exports" &&
        node?.type === "AssignmentExpression" &&
        node.left.type === "MemberExpression" &&
        node.left?.object?.name === "exports" &&
        node.left?.property.name === memberExpression?.property?.name),
  });
  return match.filter((node) => {
    if (used.has(hashNode(node))) {
      return false;
    }
    used.add(hashNode(node));
    return true;
  });
}

function hashNode(node) {
  return `${node.type}-${node.start}-${node.end}`;
}

function getASTs(fileList, dir) {
  const map = {};
  const bar = new cliProgress.SingleBar(
    {
      format: "{bar} - {filename}",
      hideCursor: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(fileList.length, 0, { filename: "N/A" });
  fileList.forEach(({ filename, content }) => {
    bar.increment({ filename: path.relative(dir, filename) });
    map[filename] = getAST(content);
    if (!map[filename]) {
      logger.warn("Skipping", filename, "- unparsable");
      delete map[filename];
      return;
    }
  });
  bar.stop();
  return map;
}

function isARequireStatement(node) {
  const conditions = [
    node?.init?.type === "CallExpression",
    node.init?.callee?.type === "Identifier",
    node.init?.callee?.name === "require",
    node.init?.arguments?.length === 1,
    node.init?.arguments[0]?.type === "Literal",
  ];
  return conditions.every((a) => a);
}

function isALiteralAssignment(node) {
  const conditions = [
    node?.type === "AssignmentExpression",
    node?.operator === "=",
    node?.right?.type === "Literal",
  ];
  return conditions.every((a) => a);
}

function isAVoidAssignment(node) {
  const conditions = [
    node?.type === "AssignmentExpression",
    node?.operator === "=",
    node?.right?.type === "UnaryExpression",
    node?.right?.operator === "void",
    node?.right?.argument?.type === "Literal",
    node?.right?.argument?.value === 0,
  ];
  return conditions.every((a) => a);
}

function getNodeModulesPath(filepath) {
  let nmPath = path.dirname(filepath);
  while (
    path.basename(nmPath) !== "node_modules" &&
    path.dirname(nmPath) !== nmPath
  ) {
    nmPath = path.dirname(nmPath);
  }
  return nmPath;
}

let hasBeenCalled = false;
async function die(node, tree) {
  if (hasBeenCalled) return;
  console.log("Dying.");
  hasBeenCalled = true;
  await Promise.all([
    fs.writeFile("die-tree.json", JSON.stringify(tree, null, 2), { flag: "w" }),
    fs.writeFile("die-node.json", JSON.stringify(node, null, 2), { flag: "w" }),
  ]);
  process.exit(1);
}

function figureOutInitialization(tree, filename) {
  return (node) => {
    node.filename = filename;
    if (node?.property?.type === "MemberExpression") {
      let declarations = findSymbolDeclaration(node.property, tree);
      if (declarations.length === 0) {
        die(node.property, tree);
      } else {
        node.initialized = declarations
          .map((declaration) => {
            if (isARequireStatement(declaration)) {
              if (!declaration?.init?.arguments[0]?.value) {
                die(declaration, tree);
              }
              const requiredFrom = declaration.init.arguments[0].value;
              let treeToPull;
              if (requiredFrom.startsWith("./")) {
                treeToPull = path.resolve(filename, requiredFrom);
              } else {
                treeToPull = path.join(
                  getNodeModulesPath(filename),
                  requiredFrom
                );
              }
              return { filename: treeToPull };
            } else if (isALiteralAssignment(declaration)) {
              return {
                filename,
                loc: declaration.right.loc,
                value: declaration.right.value,
              };
            } else if (!isAVoidAssignment(declaration)) {
              const assignment = resolveMultiAssignment(declaration);
              if (!assignment.type === "Literal") {
                die(assignment, tree);
              } else {
                return {
                  filename,
                  loc: assignment.loc,
                  value: assignment.value,
                };
              }
            }
          })
          .filter((a) => a);
      }
    }
    return node;
  };
}

function resolveMultiAssignment(node) {
  while (
    node?.right?.type === "AssignmentExpression" &&
    node?.right?.operator === "="
  ) {
    node = node.right;
  }
  if (isALiteralAssignment(node.right)) {
    return node.right;
  }
  return node;
}

function normalizeNode(node) {
  const { loc, filename, initialized } = node;
  const answer = {
    type: "EnvironmentVariable",
  };

  if (node?.property?.type === "Identifier") {
    answer.name = node.property.name;
  } else if (node?.property?.type === "Literal") {
    answer.name = node.property.value;
  } else if (node?.property?.type === "MemberExpression") {
    if (node.initialized) {
      const val = node.initialized.find((elem) => elem?.value);
      if (val) {
        answer.name = val.value;
      }
    }
    if (!answer.name) {
      answer.computed = getObjectNotation(node.property);
    }
  } else {
    console.error(node, node.constructor.name);
  }

  Object.assign(answer, {
    reference: {
      filename,
      loc,
    },
  });
  if (initialized) {
    Object.assign(answer, { initialized });
  }
  return answer;
}

async function getEnvVars(dir, logger) {
  logger.info(`Scanning ${dir}`);
  const contents = await globFiles(dir);
  logger.info(`${contents.length} files found.`);
  logger.info("Parsing Contents...");
  const allTrees = getASTs(contents, dir);
  const bar = new cliProgress.SingleBar(
    {
      format: "{bar} - {filename}",
      hideCursor: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic
  );

  logger.info("Looking for references to process.env...");
  bar.start(contents.length, 0, { filename: "N/A" });
  const allVars = Object.keys(allTrees)
    .map((filename) => {
      bar.increment({ filename: path.relative(dir, filename) });
      const ast = allTrees[filename];
      let success;
      if (isFrom({ propName: "env", objName: "process", tree: ast })) {
        success = (node) =>
          (node.type === "MemberExpression" && isProcessDotEnv(node)) ||
          isFromEnv(node);
      } else {
        success = (node) =>
          node.type === "MemberExpression" && isProcessDotEnv(node);
      }
      const raw = treeFilter(ast, {
        success,
      });
      const nodes = Array.isArray(raw) ? raw : [raw];
      return nodes.map(figureOutInitialization(ast, filename));
    })
    .flat()
    .filter(exists);
  bar.stop();

  const output = allVars.map(normalizeNode).filter((a) => a);

  return output.sort((a, b) => {
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
