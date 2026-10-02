import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The owner's source image, pinned to GitHub commit 4d606592631a0ee9c8fb0bc72ba0e750389a9b30.
const approvedSha256 = '41ef0ec029185361aea9b2370f373bfdfa4ec4d6ede59005b99ee6190c92fce7';

describe('approved XYP3RN identity', () => {
  it.each(['../app/brand/xyp3rn-logo.png', '../../../galaxy/viewer/xyp3rn-logo.png'])(
    '%s preserves the exact approved artwork', (path) => {
      const bytes = readFileSync(new URL(path, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(approvedSha256);
    },
  );
});
