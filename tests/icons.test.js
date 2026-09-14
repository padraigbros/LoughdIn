import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Returns the farthest drawn pixel from the tile centre and the vertical centre
// of the drawn area, both as a fraction of the tile width.
async function extent(file, isDrawn) {
  const { data, info } = await sharp(join(appRoot, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const size = info.width;
  const centre = size / 2;
  let farthest = 0, top = size, bottom = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!isDrawn(data[i], data[i + 1], data[i + 2], data[i + 3])) continue;
      farthest = Math.max(farthest, Math.hypot(x + .5 - centre, y + .5 - centre));
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return { farthest: farthest / size, middle: (top + bottom) / 2 / size };
}

// Launchers mask the 108dp adaptive foreground to any shape containing the
// central 66dp circle, so art outside a 33dp radius can be cut off.
for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  test(`${density} adaptive foreground stays inside the launcher safe zone`, async () => {
    const file = `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`;
    const { farthest, middle } = await extent(file, (r, g, b, a) => a > 16);
    assert.ok(farthest * 108 <= 33, `${file} reaches ${(farthest * 108).toFixed(1)}dp from centre`);
    assert.ok(farthest * 108 >= 28, `${file} keyhole shrank to ${(farthest * 108).toFixed(1)}dp`);
    assert.ok(Math.abs(middle - .5) * 108 <= 2, `${file} art is off centre by ${((middle - .5) * 108).toFixed(1)}dp`);
  });
}

// Chrome masks maskable PWA icons to a circle of 40% of the icon width.
for (const size of [192, 512]) {
  test(`${size}px maskable icon keeps the keyhole inside the safe circle`, async () => {
    const file = `icons/icon-${size}.png`;
    const background = [0x10, 0x2f, 0x2d];
    const { farthest } = await extent(file, (r, g, b) => Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]) > 24);
    assert.ok(farthest <= .4, `${file} reaches ${(farthest * 100).toFixed(1)}% from centre`);
  });
}
