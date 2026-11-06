const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { readParent } = require('./parent-upgrade.cjs');

const coordinates = { groupId: 'org.apache.sling', artifactId: 'sling-bundle-parent', version: '66' };
const fields = '<groupId>org.apache.sling</groupId><artifactId>sling-bundle-parent</artifactId><version>66</version>';
const pom = `<project><parent>${fields}</parent></project>`;

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/opencode/sling-xml-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'pom.xml');
  return async (xml) => {
    await fs.writeFile(file, xml);
    return readParent(file);
  };
}

test('XML parent reader supports absent, default and prefixed namespaces', async (t) => {
  const read = await fixture(t);
  for (const xml of [pom, pom.replace('<project>', '<project xmlns="http://maven.apache.org/POM/4.0.0">'),
    `<m:project xmlns:m="http://maven.apache.org/POM/4.0.0" xmlns:p="http://maven.apache.org/POM/4.0.0">
      <p:parent><m:groupId>org.apache.sling</m:groupId><p:artifactId>sling-bundle-parent</p:artifactId>
      <m:version>66</m:version></p:parent></m:project>`]) {
    assert.deepEqual(await read(xml), coordinates);
  }
});

test('XML parent reader ignores comments, nested parents and foreign namespace lookalikes', async (t) => {
  const read = await fixture(t);
  const xml = `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:other="urn:other">
    <!-- <parent><version>999</version></parent> -->
    <?ignored parent?>
    <build><parent>${fields.replace('66', '999')}</parent></build>
    <other:parent>${fields.replace('66', '999')}</other:parent>
    <parent><other:version>999</other:version>${fields}</parent>
  </project>`;
  assert.deepEqual(await read(xml), coordinates);
});

test('XML text preserves strings and coalesces comments, CDATA and character references', async (t) => {
  const read = await fixture(t);
  assert.deepEqual(await read(`<project><parent><groupId> org.apache.sling </groupId>
    <artifactId><![CDATA[sling]]>-bundle-parent</artifactId><version>6<!-- not 999 -->&#54;</version>
    </parent></project>`), coordinates);
  assert.deepEqual(await read(pom.replace('66', '00066')), { ...coordinates, version: '00066' });
});

test('XML reader decodes UTF-8 BOM, ISO-8859-1 and both UTF-16 byte orders', async (t) => {
  const read = await fixture(t);
  assert.deepEqual(await read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pom)])), coordinates);
  const latin1 = '<?xml version="1.0" encoding="ISO-8859-1"?>' + pom.replace('sling-bundle-parent', 'caf\u00e9\u0080');
  assert.deepEqual(await read(Buffer.from(latin1, 'latin1')), { ...coordinates, artifactId: 'caf\u00e9\u0080' });
  const utf16 = '<?xml version="1.0" encoding="UTF-16"?>' + pom;
  const littleEndian = Buffer.from(utf16, 'utf16le');
  const bigEndian = Buffer.from(littleEndian).swap16();
  for (const bytes of [littleEndian, bigEndian,
    Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])]) {
    assert.deepEqual(await read(bytes), coordinates);
  }
});

test('XML parent reader rejects missing, empty, nested and wrong-namespace coordinates', async (t) => {
  const read = await fixture(t);
  for (const xml of ['<project/>', `<project><build><parent>${fields}</parent></build></project>`,
    `<projects>${pom}</projects>`, `<project xmlns="urn:maven"><parent xmlns="">${fields}</parent></project>`,
    pom.replace('<groupId>org.apache.sling</groupId>', ''), pom.replace('sling-bundle-parent', ' '),
    pom.replace('<version>66</version>', '<version><nested>66</nested></version>')]) {
    await assert.rejects(read(xml));
  }
});

test('XML reader rejects malformed XML, multiple roots, unbound prefixes, DTDs and unknown entities', async (t) => {
  const read = await fixture(t);
  for (const xml of ['', '<not-xml', pom + pom, pom.replace('</parent>', '</parents>'),
    pom.replace('<project>', '<project name="a" name="b">'), pom.replace('<parent>', '<other:parent>'),
    pom.replace('66', '&unknown;'), '<!DOCTYPE project>' + pom,
    '<!DOCTYPE project [<!ENTITY version "66">]>' + pom.replace('66', '&version;'),
    '<!DOCTYPE project SYSTEM "file:///does/not/exist">' + pom]) {
    await assert.rejects(read(xml));
  }
});

test('XML reader rejects invalid bytes and unsupported declared encodings instead of replacing data', async (t) => {
  const read = await fixture(t);
  for (const bytes of [Buffer.concat([Buffer.from('<project>'), Buffer.from([0xff]), Buffer.from('</project>')]),
    Buffer.from('<?xml version="1.0" encoding="ASCII"?>' + pom.replace('66', '\u00e9')),
    Buffer.from('<?xml version="1.0" encoding="unknown-encoding"?>' + pom)]) {
    await assert.rejects(read(bytes));
  }
});
