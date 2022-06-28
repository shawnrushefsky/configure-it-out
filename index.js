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

function walkObject(node) {
  return Object.keys(node)
    .map((key) => {
      if (Array.isArray(node[key])) {
        return node[key].map(getProcessEnvNodes);
      } else {
        return getProcessEnvNodes(node[key]);
      }
    })
    .flat();
}

let maybes = [];

function getProcessEnvNodes(node) {
  if (!node) {
    return;
  }
  if (node.constructor.name !== "Node") {
    return;
  }
  const leaves = ["Identifier", "Literal", "TemplateElement", "ThisExpression"];
  if (leaves.includes(node.type)) {
    return;
  }

  let val = [];
  if (node.type === "MemberExpression" && isProcessDotEnv(node)) {
    val = node;
  } else if (isFromEnv(node)) {
    maybes.push(node);
  } else {
    val = walkObject(node);
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
  return true;
}

async function getEnvVars() {
  const dir = path.resolve(process.argv[2]);
  const contents = await globFiles(dir);
  const allVars = contents
    .map(({ content, filename }) => {
      try {
        const ast = Parser.extend(jsx()).parse(content, {
          ecmaVersion: 20202,
          sourceType: "module",
          allowHashBang: true,
        });
        fs.writeFile(`${filename}-tree.json`, JSON.stringify(ast, null, 2));
        const raw = getProcessEnvNodes(ast);
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
        return nodes;
      } catch (e) {
        console.error(filename);
        console.error(e);
      }
    })
    .flat()
    .filter(exists)
    .map((node) => {
      if (node.property.type === "Identifier") {
        return node.property.name;
      } else {
        console.error(node);
      }
    });
  return allVars;
}

getEnvVars().then((vars) => {
  console.log(vars);
  console.log(maybes);
});
