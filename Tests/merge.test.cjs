const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { merge, conflicts } = require('../Resources/merge.js');
test('combines edits on separate lines and words', () => {
  assert.equal(
    merge(
      'red cat\nblue dog\n',
      'red kitten\nblue dog\n',
      'red cat\nblue fox\n',
    ),
    'red kitten\nblue fox\n',
  );
  assert.equal(
    merge('one blue cat', 'a blue cat', 'one blue fox'),
    'a blue fox',
  );
});
test('overlap retains both sides exactly, including EOF and CRLF', () => {
  for (const nl of ['', '\n', '\r\n']) {
    const mine = 'xyz' + nl,
      theirs = '123' + nl;
    const result = merge('abc' + nl, mine, theirs),
      [conflict] = conflicts(result);
    assert.equal(conflict.mine, mine);
    assert.equal(conflict.theirs, theirs);
  }
});
test('identical changes and neighboring insertions are retained once', () => {
  assert.equal(merge('x', 'xx', 'xx'), 'xx');
  assert.equal(merge('cat', 'big cat', 'cat!'), 'big cat!');
});
