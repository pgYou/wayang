import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IPersistenceHelper } from './types';

export class JSONFileHelper implements IPersistenceHelper {
  readonly mode = 'save' as const;

  constructor(private filePath: string) {}

  write(data: unknown): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  read(): unknown {
    if (!existsSync(this.filePath)) return null;
    return JSON.parse(readFileSync(this.filePath, 'utf-8'));
  }

  clear(): void {
    writeFileSync(this.filePath, '{}');
  }
}
