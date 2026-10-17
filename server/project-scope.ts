import { isAbsolute, relative, sep } from 'node:path';

export function withinProject(root: string, directory: string) {
  const path = relative(root, directory);
  return (
    isAbsolute(directory) &&
    (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)))
  );
}
