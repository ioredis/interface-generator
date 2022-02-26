const camelcase = require("lodash.camelcase");
const flatMap = require("lodash.flatmap");
const Redis = require("ioredis");
const { pluralize, singularize } = require("inflection");

const { packObject, addMatrix, getCommandParameters } = require("./utils");

const processArguments = (
  { name: rawName, type, token, arguments: rawArgs, flags = [] },
  rawAdd,
  typeMaps
) => {
  const add = (defs) => {
    rawAdd(defs.filter(Boolean).map((items) => items.filter(Boolean)));
  };
  const args = rawArgs && rawArgs.map(packObject);
  const name = camelcase(rawName.toLowerCase());
  const tokenDef = token
    ? {
        name: camelcase(token.toLowerCase()) || name,
        type: `'${token.toUpperCase()}'`,
      }
    : null;
  const optional = flags.includes("optional");
  const multiple = flags.includes("multiple");

  switch (type) {
    case "key":
      add([
        optional && [],
        [
          tokenDef && { ...tokenDef, name: `${name}Token` },
          { name, type: typeMaps.key, multiple },
        ],
      ]);
      break;
    case "string":
      add([
        optional && [],
        [
          tokenDef && { ...tokenDef, name: `${name}Token` },
          {
            name,
            type:
              typeof typeMaps.string === "function"
                ? typeMaps.string(name)
                : typeMaps.string,
            multiple,
          },
        ],
      ]);
      break;
    case "pattern":
      add([
        optional && [],
        [
          tokenDef && { ...tokenDef, name: `${name}Token` },
          { name, type: typeMaps.pattern, multiple },
        ],
      ]);
      break;
    case "integer":
    case "double":
    case "unix-time":
      add([
        optional && [],
        [
          tokenDef && { ...tokenDef, name: `${name}Token` },
          {
            name,
            type:
              typeof typeMaps.number === "function"
                ? typeMaps.number(name)
                : typeMaps.number,
            multiple,
          },
        ],
      ]);
      break;
    case "pure-token":
      add([optional && [], [tokenDef]]);
      break;
    case "oneof": {
      const overrides = [];
      args.forEach((arg) =>
        processArguments(
          arg,
          (processed) => {
            overrides.push(...processed);
          },
          typeMaps
        )
      );
      if (tokenDef) {
        overrides.forEach((override) => {
          override.unshift(tokenDef);
        });
      }
      add([optional && [], ...overrides]);
      break;
    }
    case "block": {
      let overrides = [[]];
      args.forEach((arg) =>
        processArguments(
          arg,
          (processed) => {
            overrides = addMatrix(overrides, processed);
          },
          typeMaps
        )
      );
      if (multiple) {
        if (overrides.length !== 1) {
          throw new Error("Overrides is not supported for blocks");
        }
        overrides.forEach((override) => {
          override.forEach(({ multiple }) => {
            if (multiple !== false) {
              throw new Error("Multiple is not supported for blocks");
            }
          });
        });
        add([
          optional && [],
          [
            tokenDef && { ...tokenDef, name: `${name}Token` },
            {
              name,
              type: `[${overrides[0]
                .map(({ name, type }) => `${name}: ${type}`)
                .join(", ")}]`,
              multiple: true,
            },
          ],
        ]);
      } else {
        if (tokenDef) {
          overrides.forEach((override) => {
            override.unshift({ ...tokenDef, name: `${name}Token` });
          });
        }
        if (optional) {
          overrides.unshift([]);
        }
        add(overrides);
      }
      break;
    }
    default:
      throw new Error(`Unsupported type ${rawName}: ${type}`);
  }
};

const processCommand = (
  def,
  subcommandArgs,
  allDefs,
  argumentTypes,
  typeMaps
) => {
  let argsDefs = [[]];
  if (argumentTypes[def.name]) {
    argsDefs = argumentTypes[def.name];
  } else if (def.arguments) {
    def.arguments.forEach((argument) => {
      processArguments(
        packObject(argument),
        (argDefs) => {
          argsDefs = addMatrix(argsDefs, argDefs);
        },
        typeMaps
      );
    });
  }

  allDefs.push({
    name: def.name,
    summary: def.summary,
    group: def.group,
    complexity: def.complexity,
    argDefs: argsDefs.map((defs) => subcommandArgs.concat(defs)),
  });
};

const shouldProvideArrayVariant = ({ name, type }, typeMaps) => {
  return (
    type === typeMaps.key || ["slot", "member"].includes(singularize(name))
  );
};

const typeOrder = ["string", "Buffer", "number"];
const uniqTypes = (types) =>
  [...new Set(types.split(" | "))]
    .sort((a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b))
    .join(" | ");

const convertToMultipleTypes = ({ name, type }, keysToArray, typeMaps) => {
  if (keysToArray && shouldProvideArrayVariant({ name, type }, typeMaps)) {
    return `${pluralize(name)}: (${type})[]`;
  }
  const multipleType = type.includes("[")
    ? `(${uniqTypes(
        type
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .map((a) => a.split(":").pop().trim())
          .join(" | ")
      )})[]`
    : `(${type})[]`;

  return `...${pluralize(name)}: ${multipleType}`;
};

function processSubcommands(def, allDefs, argumentTypes, typeMaps) {
  def.subcommands = packObject(def.subcommands);
  Object.keys(def.subcommands).forEach((subcommand) => {
    const subDef = Object.assign(packObject(def.subcommands[subcommand]), {
      name: def.name,
    });

    const commands = subcommand.split("|").slice(1);
    processCommand(
      subDef,
      commands.map((name) => ({
        name:
          commands.length > 1 ? camelcase(name.toLowerCase()) : "subcommand",
        type: `'${name.toUpperCase()}'`,
      })),
      allDefs,
      argumentTypes,
      typeMaps
    );
  });
}

async function getCommanderInterface({
  commands,
  complexityLimit,
  redisOpts,
  returnTypes,
  argumentTypes,
  typeMaps,
  ignoredBufferVariant = [],
}) {
  const allDefs = [];
  const redis = new Redis(redisOpts);

  for (const command of commands) {
    try {
      const result = packObject((await redis.command("docs", command))[1]);
      Object.assign(result, { name: command });
      if (result.subcommands) {
        processSubcommands(result, allDefs, argumentTypes, typeMaps);
      } else {
        processCommand(result, [], allDefs, argumentTypes, typeMaps);
      }
    } catch (err) {
      console.error(`Failed to parse command: ${command}`);
    }
  }

  const generatedMethodDeclarations = allDefs
    .map(({ name, summary, group, complexity, argDefs: rawArgDefs }) => {
      let argDefs = rawArgDefs;
      if (rawArgDefs.length > complexityLimit) {
        argDefs = [getCommandParameters(rawArgDefs)];
      }
      const description = `
  /**
   * ${summary}
   * - _group_: ${group}
   * - _complexity_: ${complexity}
   */`;

      let generatedFunctionDeclarations = flatMap(argDefs, (def) => {
        let returnType = "unknown";
        if (typeof returnTypes[name] === "function") {
          returnType =
            returnTypes[name](def.map(({ type }) => type)) || "unknown";
        } else if (returnTypes[name]) {
          returnType = returnTypes[name];
        }

        const hasMultipleParameter = def.find(({ multiple }) => multiple);

        return flatMap(hasMultipleParameter ? [1, 0] : [2], (withCallback) => {
          return flatMap(
            def.find(
              ({ name, type, multiple }) =>
                multiple && shouldProvideArrayVariant({ name, type }, typeMaps)
            )
              ? [false, true]
              : [false],
            (keysToArray) => {
              return (
                (name === "exec" || returnType.includes("string")) &&
                !ignoredBufferVariant.includes(name)
                  ? [false, true]
                  : [false]
              ).map((withBuffer) => {
                let localDef = def.slice(0);
                const localReturnType = withBuffer
                  ? returnType.replace(/string/g, "Buffer")
                  : returnType;
                if (withCallback) {
                  localDef.push({
                    name: "callback",
                    optional: withCallback === 2,
                    type: `Callback<${localReturnType}>`,
                  });
                }
                const argNameUsedTimes = {};
                let parameters = "";
                localDef = localDef.map((item) => {
                  const argName = item.name;
                  const usedTimes = argNameUsedTimes[argName] || 0;
                  argNameUsedTimes[argName] = usedTimes + 1;
                  const uniqueName = usedTimes
                    ? `${argName}${usedTimes}`
                    : argName;
                  return {
                    ...item,
                    name: uniqueName,
                  };
                });

                if (hasMultipleParameter) {
                  parameters = `...args: [${localDef
                    .map((item) => {
                      return item.multiple
                        ? convertToMultipleTypes(item, keysToArray, typeMaps)
                        : `${item.name}: ${item.type}`;
                    })
                    .join(", ")}]`;
                } else {
                  parameters = localDef
                    .map((item) => {
                      return item.multiple
                        ? convertToMultipleTypes(item, keysToArray, typeMaps)
                        : `${item.name}${item.optional ? "?" : ""}: ${
                            item.type
                          }`;
                    })
                    .join(", ");
                }

                const methodName = withBuffer ? `${name}Buffer` : name;
                let result = `
  ${
    methodName.includes("-") ? `['${methodName}']` : methodName
  }(${parameters}): Result<${localReturnType}, Context>;`;
                return result;
              });
            }
          );
        });
      });

      return description + generatedFunctionDeclarations.join("");
    })
    .join("\n");

  return generatedMethodDeclarations;
}

module.exports = getCommanderInterface;
