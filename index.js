'use strict';
const assert = require('assert');

const kPush = Symbol('kPush');
const kImpl = Symbol('kImpl');
const kBufferList = Symbol('kBufferList');
const kWriteHostObject = Symbol('kWriteHostObject');
const kReadHostObject = Symbol('kReadHostObject');
const kThrowDataCloneError = Symbol('kThrowDataCloneError');

const kLatestVersion = 13;

const kDataCloneError = `Error: __object__ could not be cloned`;
const kDataCloneDeserializationVersionError =
    'Unable to deserialize cloned data due to invalid or unsupported version.';
const kDataCloneDeserializationError = 'Unable to deserialize cloned data.';

function BytesNeededForVarint(value) {
  assert(Number.isInteger(value) && value >= 0);
  let result = 0;  
  do {
    result++;
    value >>= 7;
  } while (value);
  return result;
}

function Integerify(obj) {
  for (const k in obj) {
    if (typeof obj[k] === 'string') {
      obj[k] = obj[k].codePointAt(0);
    }
  }
  return obj;
}

const SerializationTag = Integerify({
  // version:uint32_t (if at beginning of data, sets version > 0)
  kVersion: 0xFF,
  // ignore
  kPadding: '\0',
  // refTableSize:uint32_t (previously used for sanity checks; safe to ignore)
  kVerifyObjectCount: '?',
  // Oddballs (no data).
  kTheHole: '-',
  kUndefined: '_',
  kNull: '0',
  kTrue: 'T',
  kFalse: 'F',
  // Number represented as 32-bit integer, ZigZag-encoded
  // (like sint32 in protobuf)
  kInt32: 'I',
  // Number represented as 32-bit unsigned integer, varint-encoded
  // (like uint32 in protobuf)
  kUint32: 'U',
  // Number represented as a 64-bit double.
  // Host byte order is used (N.B. this makes the format non-portable).
  kDouble: 'N',
  // byteLength:uint32_t, then raw data
  kUtf8String: 'S',
  kOneByteString: '"',
  kTwoByteString: 'c',
  // Reference to a serialized object. objectID:uint32_t
  kObjectReference: '^',
  // Beginning of a JS object.
  kBeginJSObject: 'o',
  // End of a JS object. numProperties:uint32_t
  kEndJSObject: '{',
  // Beginning of a sparse JS array. length:uint32_t
  // Elements and properties are written as key/value pairs, like objects.
  kBeginSparseJSArray: 'a',
  // End of a sparse JS array. numProperties:uint32_t length:uint32_t
  kEndSparseJSArray: '@',
  // Beginning of a dense JS array. length:uint32_t
  // |length| elements, followed by properties as key/value pairs
  kBeginDenseJSArray: 'A',
  // End of a dense JS array. numProperties:uint32_t length:uint32_t
  kEndDenseJSArray: '$',
  // Date. millisSinceEpoch:double
  kDate: 'D',
  // Boolean object. No data.
  kTrueObject: 'y',
  kFalseObject: 'x',
  // Number object. value:double
  kNumberObject: 'n',
  // String object, UTF-8 encoding. byteLength:uint32_t, then raw data.
  kStringObject: 's',
  // Regular expression, UTF-8 encoding. byteLength:uint32_t, raw data,
  // flags:uint32_t.
  kRegExp: 'R',
  // Beginning of a JS map.
  kBeginJSMap: ';',
  // End of a JS map. length:uint32_t.
  kEndJSMap: ':',
  // Beginning of a JS set.
  kBeginJSSet: '\'',
  // End of a JS set. length:uint32_t.
  kEndJSSet: ',',
  // Array buffer. byteLength:uint32_t, then raw data.
  kArrayBuffer: 'B',
  // Array buffer (transferred). transferID:uint32_t
  kArrayBufferTransfer: 't',
  // View into an array buffer.
  // subtag:ArrayBufferViewTag, byteOffset:uint32_t, byteLength:uint32_t
  // For typed arrays, byteOffset and byteLength must be divisible by the size
  // of the element.
  // Note: kArrayBufferView is special, and should have an ArrayBuffer (or an
  // ObjectReference to one) serialized just before it. This is a quirk arising
  // from the previous stack-based implementation.
  kArrayBufferView: 'V',
  // Shared array buffer. transferID:uint32_t
  kSharedArrayBuffer: 'u',
  // Compiled WebAssembly module. encodingType:(one-byte tag).
  // If encodingType == 'y' (raw bytes):
  //  wasmWireByteLength:uint32_t, then raw data
  //  compiledDataLength:uint32_t, then raw data
  kWasmModule: 'W',
  // A wasm module object transfer. next value is its index.
  kWasmModuleTransfer: 'w',
  // The delegate is responsible for processing all following data.
  // This "escapes" to whatever wire format the delegate chooses.
  kHostObject: '\\',
});

const ArrayBufferViewTag = Integerify({
  Int8Array: 'b',
  Uint8Array: 'B',
  Uint8ClampedArray: 'C',
  Int16Array: 'w',
  Uint16Array: 'W',
  Int32Array: 'd',
  Uint32Array: 'D',
  Float32Array: 'f',
  Float64Array: 'F',
  DataView: '?',
});

const WasmEncodingTag = Integerify({
  kRawBytes: 'y',
});

const ArrayBufferViewTypes = [Int8Array, Uint8Array, Uint8ClampedArray,
                              Int16Array, Uint16Array, Int32Array, Uint32Array,
                              Float32Array, Float64Array, DataView];
const dummy = new ArrayBuffer();
const ArrayBufferViewTags = new Map(ArrayBufferViewTypes.map(ABVType =>
  [Object.prototype.toString.call(new ABVType(dummy)), ABVType.name]
));

const ArrayBufferTagToConstructor = new Map(ArrayBufferViewTypes.map(ABVType =>
  [ArrayBufferViewTag[ABVType.name], ABVType]
));

function RegexpFlagsAsInteger(re) {
  return (re.global << 0) |
         (re.ignoreCase << 1) |
         (re.multiline << 2) |
         (re.sticky << 3) |
         (re.unicode << 4);
}

function RegexpFlagsFromInteger(v) {
  let ret = '';
  if (v & 1) ret += 'g';
  if (v & 2) ret += 'i';
  if (v & 4) ret += 'm';
  if (v & 8) ret += 'y';
  if (v & 16) ret += 'u';
  return ret;
}

class ValueSerializer  {
  constructor(delegate = null) {
    this.id_map_ = new Map();
    this.delegate_ = delegate;
    this.next_id_ = 0;
    this.array_buffer_transfer_map_ = new Map();
    this.treat_array_buffer_views_as_host_objects_ = false;

    this.written_bytes_ = 0;
  }

  WriteHeader() {
    this.WriteTag(SerializationTag.kVersion);
    this.WriteVarint(kLatestVersion);
  }

  SetTreatArrayBufferViewsAsHostObjects(mode) {
    this.treat_array_buffer_views_as_host_objects_ = mode;
  }

  WriteTag(tag) {
    this.WriteRawBytes(Buffer.from([tag]));
  }

  WriteVarint(v) {
    assert(Number.isInteger(v) && v >= 0);
    const stack_buffer = Buffer.allocUnsafe(16);
    let index = 0;
    do {
      stack_buffer[index] = (v & 0x7f) | 0x80;
      index++;
      if ((v | 0) === v)
        v >>= 7;
      else
        v = Math.floor(v / 128);
    } while (v);
    stack_buffer[index-1] &= 0x7f;
    this.WriteRawBytes(stack_buffer.slice(0, index));
  }

  WriteZigZag(value) {
    this.WriteVarint(2 * Math.abs(value) + (value < 0));
  }

  WriteDouble(value) {
    this.WriteRawBytes(new Float64Array([value]));
  }

  WriteOneByteString(chars) {
    this.WriteVarint(chars.length);
    this.WriteRawBytes(Buffer.from(chars, 'latin1'));
  }

  WriteTwoByteString(chars) {
    this.WriteVarint(chars.length * 2);
    this.WriteRawBytes(Buffer.from(chars, 'utf16le'));
  }

  WriteRawBytes(buffer) {
    if (Object.getPrototypeOf(buffer) !== Buffer.prototype) {
      buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    this.written_bytes_ += buffer.length;
    this.delegate_[kPush](buffer);
  }

  WriteUint32(value) {
    assert(value >>> 0 === value);
    return this.WriteVarint(value);
  }

  WriteUint64(hi, lo) {
    assert(hi >>> 0 === hi);
    assert(lo >>> 0 === lo);
    if (hi === 0) return this.WriteUint32(lo);

    const stack_buffer = Buffer.allocUnsafe(16);
    stack_buffer[0] = ((lo >>>  0) & 0x7f) | 0x80;
    stack_buffer[1] = ((lo >>>  7) & 0x7f) | 0x80;
    stack_buffer[2] = ((lo >>> 14) & 0x7f) | 0x80;
    stack_buffer[3] = ((lo >>> 21) & 0x7f) | 0x80;
    stack_buffer[4] = (((lo >>> 28) | (hi << 4)) & 0x7f) | 0x80;
    hi >>>= 3;
    let index = 5;
    while(hi) {
      stack_buffer[index] = (hi & 0x7f) | 0x80;
      index++;
      hi >>>= 7;
    };
    stack_buffer[index-1] &= 0x7f;
    this.WriteRawBytes(stack_buffer.slice(0, index));
  }

  TransferArrayBuffer(transfer_id, array_buffer) {
    assert(!this.array_buffer_transfer_map_.has(array_buffer));
    this.array_buffer_transfer_map_.set(array_buffer, transfer_id);
  }

  WriteObject(object) {
    if (typeof object === 'number' && ~~object === object) {
      return this.WriteInt32(object);
    }

    if (object === true) {
      return this.WriteTag(SerializationTag.kTrue);
    } else if (object === false) {
      return this.WriteTag(SerializationTag.kFalse);
    } else if (object === undefined) {
      return this.WriteTag(SerializationTag.kUndefined);
    } else if (object === null) {
      return this.WriteTag(SerializationTag.kNull);
    } else if (typeof object === 'number') {
      this.WriteTag(SerializationTag.kDouble);
      this.WriteDouble(object);
      return;
    } else if (typeof object === 'string') {
      return this.WriteString(object);
    } else {
      return this.WriteJSReceiver(object);
    }
  }

  WriteInt32(object) {
    this.WriteTag(SerializationTag.kInt32);
    this.WriteZigZag(object);
  }

  WriteString(string) {
    if (Buffer.byteLength(string, 'latin1') === string.length) {
      this.WriteTag(SerializationTag.kOneByteString);
      return this.WriteOneByteString(string);
    } else {
      const byte_length = Buffer.byteLength(string, 'utf16le');
      if ((this.written_bytes_ + 1 +
           this.BytesNeededForVarint(byte_length)) & 1) {
        this.WriteTag(SerializationTag.kPadding);
      }
      this.WriteTag(SerializationTag.kTwoByteString);
      this.WriteTwoByteString(string);
    }
  }

  WriteJSReceiver(object) {
    let id = this.id_map_.get(object);
    if (id !== undefined) {
      this.WriteTag(SerializationTag.kObjectReference);
      this.WriteVarint(id - 1);
      return;
    }

    id = this.next_id_++;
    this.id_map_.set(object, id + 1);
    
    const tag = Object.prototype.toString.call(object);
    if (ArrayBufferViewTags.has(tag)) {
      if (!this.treat_array_buffer_views_as_host_objects_) {
        this.WriteJSReceiver(object.buffer);
      }
    }

    if (typeof object === 'function') {
      this.ThrowDataCloneError(kDataCloneError, object);
    }

    if (Array.isArray(object)) {
      return this.WriteJSArray(object);
    }

    switch (tag) {
      case '[object Date]':
        return this.WriteJSDate(object);
      case '[object RegExp]':
        return this.WriteJSRegExp(object);
      case '[object Map]':
        return this.WriteJSMap(object);
      case '[object Set]':
        return this.WriteJSSet(object);
      case '[object ArrayBuffer]':
        return this.WriteJSArrayBuffer(object);
      case '[object Object]':
        return this.WriteJSObject(object);
      case '[object Boolean]':
        if (object.valueOf() === true) {
          return this.WriteTag(SerializationTag.kTrueObject);
        } else {
          return this.WriteTag(SerializationTag.kFalseObject);
        }
      case '[object Number]':
        this.WriteTag(SerializationTag.kNumberObject);
        this.WriteDouble(object.valueOf());
        return;
      case '[object String]':
        this.WriteTag(SerializationTag.kStringObject);
        this.WriteString(object.valueOf());
        return;
      default:
        const abvName = ArrayBufferViewTags.get(tag);
        if (abvName !== undefined) {
          return this.WriteJSArrayBufferView(object, abvName);
        }

        return this.WriteHostObject(object);
    }
  }

  WriteJSObject(object) {
    this.WriteTag(SerializationTag.kBeginJSObject);
    const properties_written = this.WriteJSObjectPropertiesSlow(object);
    this.WriteTag(SerializationTag.kEndJSObject);
    this.WriteVarint(properties_written);
  }

  WriteJSArray(object) {
    const length = object.length;
    this.WriteTag(SerializationTag.kBeginDenseJSArray);
    this.WriteVarint(length);
    for (let i = 0; i < length; ++i) {
      if (!Object.prototype.hasOwnProperty.call(object, i))
        this.WriteTag(SerializationTag.kTheHole);
      else
        this.WriteObject(object[i]);
    }
    const properties_written = this.WriteJSObjectPropertiesSlow(object, true);
    this.WriteTag(SerializationTag.kEndDenseJSArray);
    this.WriteVarint(properties_written);
    this.WriteVarint(length);
  }

  WriteJSDate(date) {
    this.WriteTag(SerializationTag.kDate);
    this.WriteDouble(+date);
  }

  WriteJSRegExp(regexp) {
    this.WriteTag(SerializationTag.kRegExp);
    this.WriteString(regexp.source);
    this.WriteVarint(RegexpFlagsAsInteger(regexp));
  }

  WriteJSMap(map) {
    this.WriteTag(SerializationTag.kBeginJSMap);
    let length = 0;
    for (const [key, value] of map) {
      this.WriteObject(key);
      this.WriteObject(value);
      length += 2;
    }
    this.WriteTag(SerializationTag.kEndJSMap);
    this.WriteVarint(length);
  }

  WriteJSSet(set) {
    this.WriteTag(SerializationTag.kBeginJSSet);
    let length = 0;
    for (const value of set) {
      this.WriteObject(value);
      length++;
    }
    this.WriteTag(SerializationTag.kEndJSSet);
    this.WriteVarint(length);
  }

  WriteJSArrayBuffer(ab) {
    const transfer_entry = this.array_buffer_transfer_map_.get(ab);
    if (transfer_entry !== undefined) {
      this.WriteTag(SerializationTag.kArrayBufferTransfer);
      this.WriteVarint(transfer_entry);
      return;
    }

    this.WriteTag(SerializationTag.kArrayBuffer);
    this.WriteVarint(ab.byteLength);
    this.WriteRawBytes(Buffer.from(ab, 0, ab.byteLength));
  }

  WriteJSArrayBufferView(abv, name) {
    if (this.treat_array_buffer_views_as_host_objects_)
      return this.WriteHostObject(abv);

    this.WriteTag(SerializationTag.kArrayBufferView);
    this.WriteVarint(ArrayBufferViewTags[name]);
    this.WriteVarint(abv.byteOffset);
    this.WriteVarint(abv.byteLength);
  }

  WriteHostObject(object) {
    this.WriteTag(SerializationTag.kHostObject);
    if (this.delegate_ !== null) {
      return this.delegate_[kWriteHostObject](object);
    }
    this.ThrowDataCloneError(kDataCloneError, object);
  }

  WriteJSObjectPropertiesSlow(object, skipNumericProperties = false) {
    const keys = Object.keys(object);
    for (let i = 0; i < keys.length; ++i) {
      this.WriteObject(keys[i]);
      this.WriteObject(object[keys[i]]);
    }
    return keys.length;
  }

  ThrowDataCloneError(template, object) {
    const message = template.replace(/__object__/g, String(object));
    if (this.delegate_ !== null) {
      return this.delegate_[kThrowDataCloneError](message);
    } else {
      throw new Error(message);
    }
  }
}

class ValueDeserializer {
  constructor(buffer, delegate = null) {
    this.id_map_ = new Map();
    this.delegate_ = delegate;
    this.next_id_ = 0;
    this.array_buffer_transfer_map_ = new Map();
    this.buffer_ = Buffer.from(buffer.buffer,
                               buffer.byteOffset,
                               buffer.byteLength);
    this.position_ = 0;
    this.version_ = 0;
  }

  get end_() {
    return this.buffer_.length;
  }

  get byte_() {
    return this.buffer_[this.position_];
  }

  ReadHeader() {
    if (this.PeekTag() === SerializationTag.kVersion) {
      this.ReadTag();
      this.version_ = this.ReadVarint();
      if (this.version_ > kLatestVersion) {
        throw new Error(kDataCloneDeserializationVersionError);
      }
    }
  }

  PeekTag() {
    const pos = this.position_;
    while (pos < this.end_ &&
           this.buffer_[pos] === SerializationTag.kPadding) pos++;
    return this.buffer_[pos];
  }

  ConsumeTag() {
    const tag = this.ReadTag();
    assert(tag !== undefined);
  }

  ReadTag() {
    while (this.position_ < this.end_ &&
           this.byte_ === SerializationTag.kPadding) {
      this.position_++;
    }

    const ret = this.byte_;
    this.position_++;
    return ret;
  }

  ReadVarint() {
    let value = 0, multiplier = 1, has_another_byte = false;

    do {
      value += (this.byte_ & 0x7f) * multiplier;
      multiplier *= 128;
      has_another_byte = this._byte & 0x80;
      this.position_++;
    } while (has_another_byte);

    if (this.position_ > this.end_)
      throw new Error(kDataCloneDeserializationError);

    return value;
  }

  ReadZigZag() {
    const unsigned_value = this.ReadVarint();
    if ((unsigned_value | 0) === unsigned_value) {
      if (unsigned_value & 1) {
        return -(unsigned_value >> 1);
      } else {
        return (unsigned_value >> 1);
      }
    }

    if (unsigned_value & 1) {
      return -Math.floor(unsigned_value / 2);
    } else {
      return Math.floor(unsigned_value / 2);
    }
  }

  ReadDouble() {
    const v = this.buffer_.readDoubleLE(this.position_);
    this.position_ += 8;
    return v;
  }

  ReadRawBytes(size) {
    const v = this.buffer_.slice(this.position_, this.position_ + size);
    this.position_ += size;
    return v;
  }

  ReadUint32() {
    return this.ReadVarint();
  }

  ReadUint64() {
    let hi = 0, lo = 0;

    let last;
    for (last = 0; this.buffer_[this.position_ + last] & 0x80; ++last);
    if (last > 9) throw new Error(kDataCloneDeserializationError);
    switch (last) {
      case 9: hi += (this.buffer_[this.position_+9] & 0x7f) * 0x80000000;
      case 8: hi += (this.buffer_[this.position_+8] & 0x7f) << 24;
      case 7: hi += (this.buffer_[this.position_+7] & 0x7f) << 17;
      case 6: hi += (this.buffer_[this.position_+6] & 0x7f) << 10;
      case 5: hi += (this.buffer_[this.position_+5] & 0x7f) << 3;
      case 4: hi += (this.buffer_[this.position_+4] & 0x70) >> 4;
              lo += (this.buffer_[this.position_+4] & 0xf) * (1 << 28);
      case 3: lo += (this.buffer_[this.position_+3] & 0x7f) << 21;
      case 2: lo += (this.buffer_[this.position_+2] & 0x7f) << 14;
      case 1: lo += (this.buffer_[this.position_+1] & 0x7f) << 7;
      case 0: lo += (this.buffer_[this.position_+0] & 0x7f);
    }

    this.position_ += last+1;
    if (this.position_ > this.end_)
      throw new Error(kDataCloneDeserializationError);

    return [hi, lo];
  }

  TransferArrayBuffer(transfer_id, array_buffer) {
    assert(!this.array_buffer_transfer_map_.has(array_buffer));
    this.array_buffer_transfer_map_.set(array_buffer, transfer_id);
  }

  ReadObject() {
    if (this.position_ > this.end_)
      throw new Error(kDataCloneDeserializationError);

    let result = this.ReadObject();
    if (Object.prototype.toString.call(result) === '[object ArrayBuffer]' &&
        this.PeekTag() === SerializationTag.kArrayBufferView) {
      this.ConsumeTag();
      result = this.ReadJSArrayBufferView(result);
    }
    return result;
  }

  ReadObject() {
    const tag = this.ReadTag();
    switch (tag) {
      case SerializationTag.kVerifyObjectCount:
        this.ReadVarint();
        return this.ReadObject();
      case SerializationTag.kUndefined:
        return undefined;
      case SerializationTag.kNull:
        return null;
      case SerializationTag.kTrue:
        return true;
      case SerializationTag.kFalse:
        return false;
      case SerializationTag.kInt32:
        return this.ReadZigZag();
      case SerializationTag.kUint32:
        return this.ReadVarint();
      case SerializationTag.kDouble:
        return this.ReadDouble();
      case SerializationTag.kUtf8String:
        return this.ReadUtf8String();
      case SerializationTag.kOneByteString:
        return this.ReadOneByteString();
      case SerializationTag.kTwoByteString:
        return this.ReadTwoByteString();
      case SerializationTag.kObjectReference:
        const id = this.ReadVarint();
        return this.id_map_.get(id);
      case SerializationTag.kBeginJSObject:
        return this.ReadJSObject();
      case SerializationTag.kBeginSparseJSArray:
        return this.ReadSparseJSArray();
      case SerializationTag.kBeginDenseJSArray:
        return this.ReadDenseJSArray();
      case SerializationTag.kDate:
        return this.ReadJSDate();
      case SerializationTag.kTrueObject:
      case SerializationTag.kFalseObject:
      case SerializationTag.kNumberObject:
      case SerializationTag.kStringObject:
        return this.ReadJSValue(tag);
      case SerializationTag.kRegExp:
        return this.ReadJSRegExp();
      case SerializationTag.kBeginJSMap:
        return this.ReadJSMap();
      case SerializationTag.kBeginJSSet:
        return this.ReadJSSet();
      case SerializationTag.kArrayBuffer:
        return this.ReadJSArrayBuffer();
      case SerializationTag.kArrayBufferTransfer:
        return this.ReadTransferredJSArrayBuffer(false);
      case SerializationTag.kSharedArrayBuffer:
        return this.ReadTransferredJSArrayBuffer(true);
      case SerializationTag.kHostObject:
        return this.ReadHostObject();
      default:
        if (this.version_ < 13) {
          this.position_--;
          return this.ReadHostObject();
        }
        throw new Error(kDataCloneDeserializationError);
    }
  }

  ReadString() {
    if (this.version_ < 12) return this.ReadUtf8String();
    return this.ReadObject();
  }

  ReadUtf8String() {
    const utf8_length = this.ReadVarint();
    return this.ReadRawBytes(utf8_length).toString('utf8');
  }

  ReadOneByteString() {
    const utf8_length = this.ReadVarint();
    return this.ReadRawBytes(utf8_length).toString('latin1');
  }

  ReadTwoByteString() {
    const utf8_length = this.ReadVarint();
    return this.ReadRawBytes(utf8_length).toString('utf16le');
  }

  ReadJSObject() {
    const id = this.next_id_++;
    const object = {};
    this.id_map_.set(id, object);
    const num_properties =
        this.ReadJSObjectProperties(object, SerializationTag.kEndJSObject);
    const expected_num_properties = this.ReadVarint();
    if (num_properties !== expected_num_properties)
      throw new Error(kDataCloneDeserializationError);
    return object;
  }

  ReadSparseJSArray() {
    const length = this.ReadVarint();
    const id = this.next_id_++;
    const array = new Array();

    const num_properties =
        this.ReadJSObjectProperties(array,
                                    SerializationTag.kEndSparseJSArray)
    const expected_num_properties = this.ReadVarint();
    const expected_length = this.ReadVarint();
    if (num_properties !== expected_num_properties ||
        length !== expected_length) {
      throw new Error(kDataCloneDeserializationError);
    }

    assert(this.id_map_.has(id));
    return array;
  }

  ReadDenseJSArray() {
    const length = this.ReadVarint();
    const id = this.next_id_++;
    const array = new Array();

    for (let i = 0; i < length; ++i) {
      if (this.PeekTag() === SerializationTag.kTheHole) {
        this.ConsumeTag();
        continue;
      }

      const element = this.ReadObject();
      if (this.version_ < 11 && element === undefined) continue;
      array[i] = element;
    }

    const num_properties =
        this.ReadJSObjectProperties(array,
                                    SerializationTag.kEndDenseJSArray)
    const expected_num_properties = this.ReadVarint();
    const expected_length = this.ReadVarint();
    if (num_properties !== expected_num_properties ||
        length !== expected_length) {
      throw new Error(kDataCloneDeserializationError);
    }

    assert(this.id_map_.has(id));
    return array;
  }

  ReadJSDate() {
    const id = this.next_id_++;
    const v = new Date(this.ReadDouble());
    this.id_map_.set(id, v);
    return v;
  }

  ReadJSValue(tag) {
    const id = this.next_id_++;
    let v;
    switch (tag) {
      case SerializationTag.kTrueObject:
        v = new Boolean(true); break;
      case SerializationTag.kFalseObject:
        v = new Boolean(false); break;
      case SerializationTag.kNumberObject:
        v = new Number(this.ReadDouble()); break;
      case SerializationTag.kStringObject:
        v = new String(this.ReadString()); break;
    }
    this.id_map_.set(id, v);
    return v;
  }

  ReadJSRegExp() {
    const id = this.next_id_++;
    const pattern = this.ReadString();
    const flags = RegexpFlagsFromInteger(this.ReadVarint());
    const v = new RegExp(patter, flags);
    this.id_map_.set(id, v);
    return v;
  }

  ReadJSMap() {
    const id = this.next_id_++;
    const map = new Map();
    this.id_map_.set(id, map);

    let length = 0;
    while (true) {
      const tag = this.PeekTag();
      if (tag === SerializationTag.kEndJSMap) {
        this.ConsumeTag();
        break;
      }

      const key = this.ReadObject();
      const value = this.ReadObject();
      map.set(key, value);
      length += 2;
    }

    if (this.ReadVarint() !== length) {
      throw new Error(kDataCloneDeserializationError);
    }

    return map;
  }

  ReadJSSet() {
    const id = this.next_id_++;
    const set = new Set();
    this.id_map_.set(id, set);

    let length = 0;
    while (true) {
      const tag = this.PeekTag();
      if (tag === SerializationTag.kEndJSSet) {
        this.ConsumeTag();
        break;
      }

      const value = this.ReadObject();
      set.add(value);
      length++;
    }

    if (this.ReadVarint() !== length) {
      throw new Error(kDataCloneDeserializationError);
    }

    return set;
  }

  ReadJSArrayBuffer() {
    const id = this.next_id_++;
    const byte_length = this.ReadVarint();
    const ab = new ArrayBuffer(byte_length);
    this.buffer_.copy(new Uint8Array(ab, byte_length, 0), 0, this.position_);
    this.position_ += byte_length;
    this.id_map_.set(id, ab);
    return ab;
  }

  ReadTransferredJSArrayBuffer() {
    const id = this.next_id_++;
    const transfer_id = this.ReadVarint();
    const ab = this.array_buffer_transfer_map_.get(transfer_id);
    if (!ab) throw new Error(kDataCloneDeserializationError);
    this.id_map_.set(id, ab);
    return ab;
  }

  ReadJSArrayBufferView(ab) {
    const tag = this.ReadTag();
    const byte_offset = this.ReadVarint();
    const byte_length = this.ReadVarint();
    const id = this.next_id_++;
    const Constructor = ArrayBufferTagToConstructor.get(tag);
    const v = new Constructor(ab,
                              byte_offset,
                              byte_length / Constructor.BYTES_PER_ELEMENT);
    this.id_map_.set(id, v);
    return v;
  }

  ReadHostObject() {
    if (this.delegate_ === null)
      throw new Error(kDataCloneDeserializationError);

    const id = this.next_id_++;
    const v = this.delegate_[kReadHostObject]();
    this.id_map_.set(id, v);
    return v;
  }

  ReadJSObjectProperties(object, end_tag) {
    let num_properties = 0;

    while (true) {
      const tag = this.PeekTag();
      if (tag === end_tag) {
        this.ConsumeTag(end_tag);
        return num_properties;
      }

      const key = this.ReadObject();
      const value = this.ReadObject();
      object[key] = value;
      ++num_properties;
    }
  }

  GetWireFormatVersion() {
    return this.version_;
  }
}

class ValueSerializerDelegate {
  [kWriteHostObject](object) {
    const message = kDataCloneError.replace(/__object__/g, String(object));
    throw new Error(message);
  }
}

class ValueDeserializerDelegate {
  [kReadHostObject]() {
    throw new Error(kDataCloneDeserializationError);
  }
}

class NodeBindingSerializer extends ValueSerializerDelegate {
  constructor() {
    super();
    this[kImpl] = new ValueSerializer(this);
    this[kBufferList] = [];
  }

  writeHeader() {
    return this[kImpl].WriteHeader();
  }

  writeValue(value) {
    return this[kImpl].WriteObject(value);
  }

  releaseBuffer() {
    return Buffer.concat(this[kBufferList]);
  }

  transferArrayBuffer(transfer_id, ab) {
    return this[kImpl].TransferArrayBuffer(transfer_id, ab);
  }

  writeUint32(value) {
    return this[kImpl].WriteUint32(value);
  }

  writeUint64(hi, lo) {
    return this[kImpl].WriteUint64(hi, lo);
  }

  writeDouble(value) {
    return this[kImpl].WriteDouble(value);
  }

  writeRawBytes(buffer) {
    return this[kImpl].WriteRawBytes(buffer);
  }

  [kPush](data) {
    return this[kBufferList].push(data);
  }

  _setTreatArrayBufferViewsAsHostObjects(mode) {
    this[kImpl].SetTreatArrayBufferViewsAsHostObjects(!!mode);
  }

  _getDataCloneError(message) {
    return new Error(message);
  }

  [kThrowDataCloneError](message) {
    throw this._getDataCloneError(message);
  }

  [kWriteHostObject](input) {
    if (typeof this._writeHostObject !== 'function')
      return super[kWriteHostObject](input);

    return this._writeHostObject(input);
  }
}

class NodeBindingDeserializer extends ValueDeserializerDelegate {
  constructor(input) {
    super();
    this[kImpl] = new ValueDeserializer(input, this);
    this.buffer = input;
  }

  readHeader() {
    return this[kImpl].ReadHeader();
  }

  readValue() {
    return this[kImpl].ReadObject();
  }

  getWireFormatVersion() {
    return this[kImpl].GetWireFormatVersion();
  }

  transferArrayBuffer(transfer_id, ab) {
    return this[kImpl].TransferArrayBuffer(transfer_id, ab);
  }

  readUint32() {
    return this[kImpl].ReadUint32();
  }

  readUint64() {
    return this[kImpl].ReadUint64();
  }

  readDouble() {
    return this[kImpl].ReadDouble();
  }

  _readRawBytes(length) {
    const buf = this.readRawBytes(length);
    assert(buf.buffer === this.buffer.buffer);
    return buf.byteOffset - this.buffer.byteOffset;
  }

  readRawBytes(length) {
    return this[kImpl].ReadRawBytes(length);
  }

  [kReadHostObject]() {
    if (typeof this._readHostObject !== 'function')
      return super[kReadHostObject]();

    const ret = this._readHostObject();
    if (typeof ret !== 'object') {
      throw new TypeError('readHostObject must return an object');
    }
    return ret;
  }
}


const arrayBufferViewTypeToIndex = new Map();

{
  const dummy = new ArrayBuffer();
  for (const [i, ctor] of ArrayBufferViewTypes.entries()) {
    const tag = Object.prototype.toString.call(new ctor(dummy));
    arrayBufferViewTypeToIndex.set(tag, i);
  }
}

const bufferConstructorIndex = ArrayBufferViewTypes.push(Buffer) - 1;

class DefaultSerializer extends NodeBindingSerializer {
  constructor() {
    super();

    this._setTreatArrayBufferViewsAsHostObjects(true);
  }

  _writeHostObject(abView) {
    let i = 0;
    if (abView.constructor === Buffer) {
      i = bufferConstructorIndex;
    } else {
      const tag = Object.prototype.toString.call(abView);
      i = arrayBufferViewTypeToIndex.get(tag);

      if (i === undefined) {
        throw this._getDataCloneError(`Unknown host object type: ${tag}`);
      }
    }
    this.writeUint32(i);
    this.writeUint32(abView.byteLength);
    this.writeRawBytes(new Uint8Array(abView.buffer,
                                      abView.byteOffset,
                                      abView.byteLength));
  }
}

class DefaultDeserializer extends NodeBindingDeserializer {
  constructor(buffer) {
    super(buffer);
  }

  _readHostObject() {
    const typeIndex = this.readUint32();
    const ctor = ArrayBufferViewTypes[typeIndex];
    const byteLength = this.readUint32();
    const byteOffset = this._readRawBytes(byteLength);
    const BYTES_PER_ELEMENT = ctor.BYTES_PER_ELEMENT || 1;

    const offset = this.buffer.byteOffset + byteOffset;
    if (offset % BYTES_PER_ELEMENT === 0) {
      return new ctor(this.buffer.buffer,
                      offset,
                      byteLength / BYTES_PER_ELEMENT);
    } else {
      // Copy to an aligned buffer first.
      const copy = Buffer.allocUnsafe(byteLength);
      Buffer.prototype.copy.call(this.buffer,
                                 copy, 0, byteOffset, byteOffset + byteLength);
      return new ctor(copy.buffer,
                      copy.byteOffset,
                      byteLength / BYTES_PER_ELEMENT);
    }
  }
}

exports.Deserializer = NodeBindingDeserializer;
exports.DefaultDeserializer = DefaultDeserializer;

exports.Serializer = NodeBindingSerializer;
exports.DefaultSerializer = DefaultSerializer;

exports.serialize = function serialize(value) {
  const ser = new DefaultSerializer();
  ser.writeHeader();
  ser.writeValue(value);
  return ser.releaseBuffer();
};

exports.deserialize = function deserialize(buffer) {
  const der = new DefaultDeserializer(buffer);
  der.readHeader();
  return der.readValue();
};
