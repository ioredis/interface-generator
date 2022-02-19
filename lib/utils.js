exports.packObject = (array) => {
  const result = {};
  const length = array.length;

  for (let i = 1; i < length; i += 2) {
    result[array[i - 1]] = array[i];
  }

  return result;
};

const restParameter = {
  name: "args",
  type: "RedisValue",
  multiple: true,
};

const mergeMultipleParameters = (parameters) => {
  if (parameters.filter(({ multiple }) => multiple).length > 1) {
    const firstMultiple = parameters.findIndex(({ multiple }) => multiple);
    return [...parameters.slice(0, firstMultiple), restParameter];
  }
  return parameters;
};

/*
 * Existing:
 * [['set', RedisKey, string]]
 * Items Options:
 * [[], ['EX', number]]
 * Result:
 * [
 *   ['set', RedisKey, string],
 *   ['set', RedisKey, string, 'EX', number],
 * ]
 */
exports.addMatrix = (existing, itemsOptions) => {
  const result = [];

  existing.forEach((items) => {
    itemsOptions.forEach((options) => {
      result.push(mergeMultipleParameters([...items, ...options]));
    });
  });

  return result;
};

exports.getCommandParameters = (matrix) => {
  const allCommons = [];

  let index = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let common = null;
    for (const defs of matrix) {
      const def = defs[index];
      if (!def) {
        return mergeMultipleParameters([...allCommons, restParameter]);
      }
      if (common) {
        if (
          common.name !== def.name ||
          common.multiple !== def.multiple ||
          common.type !== def.type
        ) {
          return mergeMultipleParameters([...allCommons, restParameter]);
        }
      } else {
        common = def;
      }
    }
    allCommons.push(common);
    index += 1;
  }
};
