import qrcode from '../vendor/qrcode-generator/qrcode.mjs';

/** A QR code drawn with half-block characters, two rows per line. */
export function terminalQr(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < size + 2; r += 2) {
    let line = '';
    for (let c = -2; c < size + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      // Light modules are drawn as ink, so the code reads on dark terminals.
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
