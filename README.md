serdes
==============

[![NPM Version](https://img.shields.io/npm/v/serdes.svg?style=flat)](https://npmjs.org/package/serdes)
[![Build Status](https://travis-ci.org/addaleax/serdes.svg?style=flat&branch=master)](https://travis-ci.org/addaleax/serdes?branch=master)
[![Coverage Status](https://coveralls.io/repos/addaleax/serdes/badge.svg?branch=master)](https://coveralls.io/r/addaleax/serdes?branch=master)

Install:
`npm install serdes`

Polyfill for the Node.js 8.x serializer API:

```js
const serdes = require('serdes');

serdes.serialize({ foo: 'bar' });
  // => <Buffer ff 0d 6f 22 03 66 6f 6f 22 03 62 61 72 7b 01>
serdes.deserialize(buffer)
  // => { foo: 'bar' }
```

License
=======

MIT
