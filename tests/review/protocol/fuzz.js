// Small mutation helpers shared by the review tests. Not a test file.

export const DELETE = Symbol('delete');

// All leaf paths of a JSON like value.
export function leafPaths(value, path = [], out = []) {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) leafPaths(value[k], [...path, k], out);
    if (Object.keys(value).length === 0) out.push(path);
  } else {
    out.push(path);
  }
  return out;
}

export function getAt(obj, path) {
  let cur = obj;
  for (const k of path) cur = cur[k];
  return cur;
}

// Returns a deep copy of obj with the value at path replaced (or deleted).
export function withChange(obj, path, replacement) {
  const copy = structuredClone(obj);
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  const last = path[path.length - 1];
  if (replacement === DELETE) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
  } else {
    cur[last] = replacement;
  }
  return copy;
}

// A handful of replacements for one leaf value.
export function replacements(value) {
  const out = [DELETE];
  if (typeof value === 'string') {
    out.push(value === '' ? 'x' : (value[0] === 'a' ? 'b' : 'a') + value.slice(1));
    out.push(value + '0');
    out.push('');
  } else if (typeof value === 'number') {
    out.push(value + 1, value - 1, 0);
  } else if (typeof value === 'boolean') {
    out.push(!value);
  } else if (value === null) {
    out.push('x');
  } else if (Array.isArray(value)) {
    out.push({});
  } else if (typeof value === 'object') {
    out.push([]);
  }
  return out;
}

export const pathText = (p) => p.join('.');
