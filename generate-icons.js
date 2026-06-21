import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, size, size);

  const r = size * 0.18;
  ctx.fillStyle = '#111118';
  ctx.beginPath();
  ctx.roundRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84, r);
  ctx.fill();

  const cell = size / 10;
  const maxR = cell * 0.42;
  ctx.fillStyle = '#4dba6a';

  const A = [
    [0, 0, 1, 0, 0],
    [0, 1, 0, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ];

  const gridW = 5;
  const gridH = 7;
  const startX = size * 0.5 - (gridW * cell) / 2;
  const startY = size * 0.5 - (gridH * cell) / 2;

  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const on = A[row][col];
      const cx = startX + col * cell + cell / 2;
      const cy = startY + row * cell + cell / 2;
      const dotR = on ? maxR : maxR * 0.15;
      ctx.globalAlpha = on ? 1.0 : 0.15;
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1.0;
  return canvas.toBuffer('image/png');
}

mkdirSync('./icons', { recursive: true });
writeFileSync('./icons/icon-192.png', generateIcon(192));
writeFileSync('./icons/icon-512.png', generateIcon(512));
console.log('Icons generated: icons/icon-192.png, icons/icon-512.png');
