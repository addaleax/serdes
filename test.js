'use strict';
const common = {
  mustCall(fn, n) {
    if (n === undefined)
      n = 1;

    let count = 0;
    process.on('exit', () => {
      assert.strictEqual(count, n);
    });
    return function() {
      ++count;
      return fn.apply(this, arguments);
    };
  }
};
const serdes = require('./index.js');
const assert = require('assert');

const circular = {};
circular.circular = circular;

const objects = [
  { foo: 'bar' },
  { bar: 'baz' },
  new Uint8Array([1, 2, 3, 4]),
  new Uint32Array([1, 2, 3, 4]),
  Buffer.from([1, 2, 3, 4]),
  undefined,
  null,
  42,
  circular,
  'aou',
  'äöü',
  '\u{1f389}',
  true,
  false,
  new Boolean(true),
  new Boolean(false),
  new Number(1),
  new Number(-1),
  new Number(-1e30),
  new String(''),
  new String('abc'),
  -1e30,
  /abc/, /abc/g, /abc/i, /abc/m,
  1 << 29, 1 << 30, 1 << 31,
  [1,2,3],
  new Date(),
  new Map([[1,2],[3,4]]),
  new Set([1,2,3])
];

try {
  // Node >= 6
  objects.push(/abc/u, /abc/y);
} catch (e) {}

{
  const ser = new serdes.DefaultSerializer();
  ser.writeHeader();
  for (const obj of objects) {
    ser.writeValue(obj);
  }

  const des = new serdes.DefaultDeserializer(ser.releaseBuffer());
  des.readHeader();

  for (const obj of objects) {
    assert.deepStrictEqual(des.readValue(), obj);
  }
}

{
  for (const obj of objects) {
    assert.deepStrictEqual(serdes.deserialize(serdes.serialize(obj)), obj);
  }
}

{
  const ser = new serdes.DefaultSerializer();
  ser._getDataCloneError = common.mustCall((message) => {
    assert(message.match(/^Unknown host object type: \[object .*\]$/));
    return new Error('foobar');
  });

  ser.writeHeader();

  assert.throws(() => {
    ser.writeValue(process.stdin._handle);
  }, /foobar/);
}

{
  const ser = new serdes.DefaultSerializer();
  ser._writeHostObject = common.mustCall((object) => {
    assert.strictEqual(object, process.stdin._handle);
    const buf = Buffer.from('stdin');

    ser.writeUint32(buf.length);
    ser.writeRawBytes(buf);

    ser.writeUint64(1, 2);
    ser.writeUint64(1, 0);
    ser.writeUint64(0, 0);
    ser.writeUint64(0x102, 0x304);
    ser.writeUint64(0x80000000, 0x70000000);
    ser.writeDouble(-0.25);
  });

  ser.writeHeader();
  ser.writeValue({ val: process.stdin._handle });

  const des = new serdes.DefaultDeserializer(ser.releaseBuffer());
  des._readHostObject = common.mustCall(() => {
    const length = des.readUint32();
    const buf = des.readRawBytes(length);

    assert.strictEqual(buf.toString(), 'stdin');

    assert.deepStrictEqual(des.readUint64(), [1, 2]);
    assert.deepStrictEqual(des.readUint64(), [1, 0]);
    assert.deepStrictEqual(des.readUint64(), [0, 0]);
    assert.deepStrictEqual(des.readUint64(), [0x102, 0x304]);
    assert.deepStrictEqual(des.readUint64(), [0x80000000, 0x70000000]);
    assert.strictEqual(des.readDouble(), -0.25);
    return process.stdin._handle;
  });

  des.readHeader();

  assert.strictEqual(des.readValue().val, process.stdin._handle);
}

{
  const ser = new serdes.DefaultSerializer();
  ser._writeHostObject = common.mustCall((object) => {
    throw new Error('foobar');
  });

  ser.writeHeader();
  assert.throws(() => {
    ser.writeValue({ val: process.stdin._handle });
  }, /foobar/);
}

{
  assert.throws(() => serdes.serialize(process.stdin._handle),
                /^Error: Unknown host object type: \[object .*\]$/);
}

{
  const buf = Buffer.from('ff0d6f2203666f6f5e007b01', 'hex');

  const des = new serdes.DefaultDeserializer(buf);
  des.readHeader();

  const ser = new serdes.DefaultSerializer();
  ser.writeHeader();

  ser.writeValue(des.readValue());

  assert.deepStrictEqual(buf, ser.releaseBuffer());
  assert.strictEqual(des.getWireFormatVersion(), 0x0d);
}

{
  // Unaligned Uint16Array read, with padding in the underlying array buffer.
  const buf = Buffer.from('0'.repeat(64) + 'ff0d5c0404addeefbe', 'hex')
      .slice(32);
  assert.deepStrictEqual(serdes.deserialize(buf),
                         new Uint16Array([0xdead, 0xbeef]));
}

{
  const buf = Buffer.from('abcdef');

  const ser = new serdes.Serializer();
  ser.writeHeader();
  ser.transferArrayBuffer(1, buf.buffer);
  ser.writeValue(buf);

  const des = new serdes.Deserializer(ser.releaseBuffer());
  des.readHeader();
  des.transferArrayBuffer(1, buf.buffer);

  const read = des.readValue();
  assert.strictEqual(read.buffer, buf.buffer);
  assert.strictEqual(read.byteOffset, buf.byteOffset);
  assert.strictEqual(read.byteLength, buf.byteLength);
}
{
  const buf = Buffer.from('abcdef');

  const ser = new serdes.Serializer();
  ser.writeHeader();
  ser.writeValue(buf);

  const des = new serdes.Deserializer(ser.releaseBuffer());
  des.readHeader();

  const read = des.readValue();
  assert.notStrictEqual(read.buffer, buf.buffer);
  assert.strictEqual(read.byteOffset, buf.byteOffset);
  assert.strictEqual(read.byteLength, buf.byteLength);
}

{
  assert.throws(() => serdes.serialize(function f() {}));
}

{
  const emptyArr = new Array(4);
  const clone = serdes.deserialize(serdes.serialize(emptyArr));
  assert.strictEqual(clone.length, 4);
  assert.strictEqual(Object.keys(clone).length, 0);
}
