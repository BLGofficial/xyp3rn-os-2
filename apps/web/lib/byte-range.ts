/**
 * One `Range: bytes=…` header against a body of `size` bytes (RFC 9110 §14.1.2): a single range, open-ended
 * (`500-`) or a suffix (`-500`). Several ranges are answered as the whole body.
 * @returns the inclusive [start, end], null for no usable header, or 'unsatisfiable'
 */
export const parseRange = (header: string | null, size: number): readonly [number, number] | null | 'unsatisfiable' => {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const [start, end] = m[1] === ''
    ? [Math.max(0, size - Number(m[2])), size - 1]
    : [Number(m[1]), m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)];
  return start > end || start >= size ? 'unsatisfiable' : [start, end];
};
