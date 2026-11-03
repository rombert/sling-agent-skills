const fs = require('node:fs/promises');
const { SaxesParser } = require('saxes');

function decode(bytes) {
  let encoding;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) {
    encoding = 'utf-16le';
  } else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) {
    encoding = 'utf-16be';
  } else {
    encoding = bytes.subarray(0, 200).toString('latin1')
      .match(/^(?:\xef\xbb\xbf)?<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'utf-8';
  }
  // WHATWG TextDecoder maps Latin-1 to Windows-1252; XML's ISO-8859-1 does not.
  if (/^(?:iso-8859-1|latin-?1)$/i.test(encoding)) return bytes.toString('latin1');
  if (/^(?:us-)?ascii$/i.test(encoding) && bytes.some((byte) => byte > 0x7f)) {
    throw new Error('Non-ASCII byte in an ASCII XML document');
  }
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

async function readProject(file) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root;
  parser.on('doctype', () => { throw new Error('DOCTYPE is not supported in Maven POMs'); });
  parser.on('opentag', (tag) => {
    const node = { name: tag.local, namespace: tag.uri, content: [] };
    if (stack.length) stack.at(-1).content.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on('closetag', () => { stack.pop(); });
  const appendText = (value) => {
    if (!stack.length) return;
    const content = stack.at(-1).content;
    // Coalesce across comments/CDATA, but keep child text and tails separate.
    if (typeof content.at(-1) === 'string') content[content.length - 1] += value;
    else content.push(value);
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.write(decode(await fs.readFile(file))).close();
  if (root?.name !== 'project') throw new Error('Expected a single Maven project element');
  return root;
}

function children(element, name) {
  return element?.content.filter((part) => typeof part !== 'string' && part.namespace === element.namespace &&
    (name === undefined || part.name === name)) ?? [];
}

const child = (element, name) => children(element, name)[0];
const value = (element) => typeof element?.content[0] === 'string' ? element.content[0] : '';
const text = (element, name, fallback = '') => {
  const found = child(element, name);
  return (found ? value(found) : fallback).trim();
};

function* iterText(element) {
  for (const part of element.content) {
    if (typeof part === 'string') yield part;
    else yield* iterText(part);
  }
}

module.exports = { readProject, children, child, value, text, iterText };
