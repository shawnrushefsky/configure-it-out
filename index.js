const { Parser } = require("acorn");
const jsx = require("acorn-jsx");
const fs = require("fs").promises;
const glob = require("glob");
const path = require("path");

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

async function getEnvVars() {
  const dir = path.resolve(process.argv[2]);
  const contents = await globFiles(dir);
  const allVars = contents
    .map(({ content, filename }) => {
      try {
        const ast = Parser.extend(jsx()).parse(content, {
          ecmaVersion: 2022,
          sourceType: "module",
          allowHashBang: true,
        });
        fs.writeFile(`${filename}-tree.json`, JSON.stringify(ast, null, 2));
        const raw = treeFilter(ast, {
          success: (node) =>
            node.type === "MemberExpression" && isProcessDotEnv(node),
          maybe: isFromEnv,
        });
        const nodes = Array.isArray(raw) ? raw : [raw];
        if (
          maybes.length &&
          isFrom({ propName: "env", objName: "process", tree: ast })
        ) {
          nodes.push(
            ...maybes
              .map(({ id: { properties } }) => {
                return properties.map((prop) => {
                  return { property: prop.key };
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
      if (node?.property?.type === "Identifier") {
        return node.property.name;
      } else {
        console.error(node, node.constructor.name);
      }
    });
  return Array.from(new Set(allVars)).sort();
}

getEnvVars().then((vars) => {
  console.log(vars);
});
