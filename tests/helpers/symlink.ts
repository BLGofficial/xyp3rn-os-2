import { statSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// Unprivileged Windows refuses file symlinks (EPERM) but allows directory junctions, which Node also reports as
// symbolic links. On that refusal, link to the target's directory instead: the link stays inside or outside the
// root exactly where the target is, so escape checks exercise the same rule on every platform.
export function linkTo(target: string, path: string): void {
  try {
    symlinkSync(target, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    symlinkSync(statSync(target).isDirectory() ? target : dirname(target), path, 'junction');
  }
}
