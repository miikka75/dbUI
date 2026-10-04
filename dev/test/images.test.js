// images.test.js — fitting a picked image under the cap it is stored against (images.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Images = require('../../images');

// A resize stand-in: the data URL's length is whatever `sizes` says for that (max, q), and every call is
// logged so the order of attempts is visible.
function fakeResize(sizes) {
  const calls = [];
  const fn = (max, q) => { calls.push(max + '@' + q); return Promise.resolve('x'.repeat(sizes[max + '@' + q] || 0)); };
  fn.calls = calls;
  return fn;
}

describe('fit', () => {
  it('stops at the first step that fits, without trying the rest', async () => {
    const r = fakeResize({ '1600@0.8': 2000, '1600@0.65': 900 });
    const url = await Images.fit(r, 1000, Images.ASSET_STEPS);
    assert.equal(url.length, 900);
    assert.deepEqual(r.calls, ['1600@0.8', '1600@0.65']);
  });
  it('a result exactly at the cap fits', async () => {
    const r = fakeResize({ '256@0.85': 350000 });
    assert.equal((await Images.fit(r, 350000, Images.AVATAR_STEPS)).length, 350000);
  });
  it('rejects as too large once every step has overflowed', async () => {
    const r = fakeResize({ '256@0.85': 350001 });
    await assert.rejects(Images.fit(r, 350000, Images.AVATAR_STEPS), (e) => e.tooLarge === true);
    assert.deepEqual(r.calls, ['256@0.85']);
  });
  it('a failing resize rejects with its own error, not as too large', async () => {
    const boom = () => Promise.reject(new Error('unreadable'));
    await assert.rejects(Images.fit(boom, 10, Images.ASSET_STEPS), /unreadable/);
  });
  it('the asset ladder only ever shrinks', () => {
    const s = Images.ASSET_STEPS;
    for (let i = 1; i < s.length; i++) assert.ok(s[i].max <= s[i - 1].max && s[i].q <= s[i - 1].q, 'step ' + i);
  });
});

describe('alpha and the encoder', () => {
  it('an opaque image takes JPEG; any transparent pixel takes WebP', () => {
    const opaque = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
    const clear = new Uint8ClampedArray([1, 2, 3, 255, 0, 0, 0, 0]);
    assert.equal(Images.hasAlpha(opaque), false);
    assert.equal(Images.hasAlpha(clear), true);
    assert.equal(Images.encoderFor(Images.hasAlpha(opaque)), 'image/jpeg');
    assert.equal(Images.encoderFor(Images.hasAlpha(clear)), 'image/webp');
  });
});

describe('the blob-store tier', () => {
  it('its ladder only ever shrinks, and starts at lightbox size', () => {
    const s = Images.STORE_STEPS;
    assert.equal(s[0].max, 2560);
    for (let i = 1; i < s.length; i++) assert.ok(s[i].max <= s[i - 1].max && s[i].q <= s[i - 1].q, 'step ' + i);
  });
  it('a byte cap becomes the data-URL length that holds it', () => {
    assert.equal(Images.capChars(3), 4);
    assert.equal(Images.capChars(2 * 1024 * 1024), Math.floor(2 * 1024 * 1024 * 4 / 3));
  });
  it('a data URL decodes to its bytes and type, for the upload', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const b = Images.dataUrlBytes('data:image/png;base64,' + png);
    assert.equal(b.type, 'image/png');
    assert.deepEqual(Buffer.from(b.bytes), Buffer.from(png, 'base64'));
    assert.equal(Images.dataUrlBytes('https://x/y.png'), null);
    assert.equal(Images.dataUrlBytes('data:text/plain,hello'), null, 'not base64: nothing an image upload makes');
  });
});
