import { expect, test } from 'vitest';
import { fitGrid } from './fitGrid';

const ratio = 464 / 696;
const [W, H, gap, cw, ch] = [1776, 720, 24, 40, 140];

test('cards never exceed the box', () => {
  for (const n of [1, 2, 3, 8, 12, 21, 40]) {
    const g = fitGrid(n, W, H, ratio, gap, cw, ch, 200);
    const cardW = g.frameH * ratio + cw;
    expect(g.cols * cardW + (g.cols - 1) * gap).toBeLessThanOrEqual(W);
    if (!g.scroll) {
      const rows = Math.ceil(n / g.cols);
      expect(rows * (g.frameH + ch) + (rows - 1) * gap).toBeLessThanOrEqual(H);
    }
  }
});

test('12 frames fit without scrolling, 60 scroll', () => {
  expect(fitGrid(12, W, H, ratio, gap, cw, ch, 200).scroll).toBe(false);
  expect(fitGrid(60, W, H, ratio, gap, cw, ch, 200).scroll).toBe(true);
});
