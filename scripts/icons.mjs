// Rebuild all web and Android launcher sizes from a single editable vector.
import sharp from 'sharp';
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';

const master = await readFile(new URL('../icons/keyhole.svg', import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);
const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
for (const size of [192, 512]) {
  await writeFile(new URL(`icons/icon-${size}.png`, root), await png(master, size));
  await copyFile(new URL(`icons/icon-${size}.png`, root), new URL(`icon-${size}.png`, root));
}
// The master keeps the entire keyhole inside the maskable central safe circle.
// Android launchers only guarantee the central 66dp of the 108dp foreground, so
// the keyhole is shrunk about its best-fit centre (y 252) to a ~31.5dp radius.
const foreground = master
  .replace('<rect width="512" height="512" fill="#102f2d"/>', '')
  .replace(/^(<svg[^>]*>)([\s\S]*)(<\/svg>\s*)$/, '$1<g transform="translate(256 256) scale(.84) translate(-256 -252)">$2</g>$3');
for (const [density, legacy, adaptive] of [['mdpi',48,108],['hdpi',72,162],['xhdpi',96,216],['xxhdpi',144,324],['xxxhdpi',192,432]]) {
  const dir = new URL(`android/app/src/main/res/mipmap-${density}/`, root);
  await mkdir(dir, {recursive: true});
  const image = await png(master, legacy);
  await writeFile(new URL('ic_launcher.png', dir), image);
  await writeFile(new URL('ic_launcher_round.png', dir), image);
  await writeFile(new URL('ic_launcher_foreground.png', dir), await png(foreground, adaptive));
}
console.log('Updated web and Android icons from icons/keyhole.svg');
