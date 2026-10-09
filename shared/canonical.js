// Deterministic JSON text. Same input always gives the same bytes.
import { utf8Encode } from './encoding.js';

const MAX_DEPTH = 64;

// True for strings with no lone surrogates.
export function isWellFormedString(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const fnToString = Function.prototype.toString;

// True for a built in function (its source text ends in "[native code]").
function isNativeFunction(f) {
  if (typeof f !== 'function') return false;
  try {
    return /\{\s*\[native code\]\s*\}\s*$/.test(fnToString.call(f));
  } catch {
    return false;
  }
}

// True for plain objects: prototype is null or Object.prototype.
// Objects from another realm (iframe, vm context) have their own Object.prototype, so for
// those we check that the prototype looks like the real one: no prototype of its own and
// built in constructor, isPrototypeOf and hasOwnProperty. A hand made look alike fails.
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto === null || proto === Object.prototype) return true;
  if (Object.getPrototypeOf(proto) !== null) return false;
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  const isProto = Object.getOwnPropertyDescriptor(proto, 'isPrototypeOf');
  const hasOwn = Object.getOwnPropertyDescriptor(proto, 'hasOwnProperty');
  return Boolean(
    ctor &&
      isProto &&
      hasOwn &&
      isNativeFunction(ctor.value) &&
      ctor.value.name === 'Object' &&
      isNativeFunction(isProto.value) &&
      isNativeFunction(hasOwn.value)
  );
}

function write(v, depth) {
  if (depth > MAX_DEPTH) throw new TypeError('canonicalize: too deeply nested');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      if (!isWellFormedString(v)) throw new TypeError('canonicalize: lone surrogate in string');
      return JSON.stringify(v);
    case 'number':
      if (!Number.isSafeInteger(v)) throw new TypeError('canonicalize: only safe integers are allowed');
      return String(v === 0 ? 0 : v);
    case 'object':
      break;
    default:
      throw new TypeError('canonicalize: unsupported type ' + typeof v);
  }
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || Object.keys(v).length !== v.length) {
      throw new TypeError('canonicalize: unsupported array');
    }
    let out = '[';
    for (let i = 0; i < v.length; i++) {
      const desc = Object.getOwnPropertyDescriptor(v, i);
      if (!desc || !('value' in desc)) throw new TypeError('canonicalize: accessor elements are not allowed');
      if (i > 0) out += ',';
      out += write(desc.value, depth + 1);
    }
    return out + ']';
  }
  if (!isPlainObject(v)) throw new TypeError('canonicalize: only plain objects are allowed');
  if (Object.getOwnPropertySymbols(v).length > 0) throw new TypeError('canonicalize: symbol keys are not allowed');
  const keys = Object.keys(v);
  if (Object.getOwnPropertyNames(v).length !== keys.length) {
    throw new TypeError('canonicalize: non enumerable properties are not allowed');
  }
  keys.sort();
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === '__proto__') throw new TypeError('canonicalize: __proto__ key is not allowed');
    if (!isWellFormedString(k)) throw new TypeError('canonicalize: lone surrogate in key');
    const desc = Object.getOwnPropertyDescriptor(v, k);
    if (!('value' in desc)) throw new TypeError('canonicalize: accessor properties are not allowed');
    if (i > 0) out += ',';
    out += JSON.stringify(k) + ':' + write(desc.value, depth + 1);
  }
  return out + '}';
}

export function canonicalize(value) {
  return write(value, 0);
}

export function canonicalBytes(value) {
  return utf8Encode(canonicalize(value));
}
