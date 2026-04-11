import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IPersistenceHelper } from './types';

export class JSONLFileHelper implements IPersistenceHelper {
  readonly mode = 'append' as const;

  constructor(private filePath: string) {}

  write(entry: unknown): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
  }

  read(): any[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line));
  }

  readFromEnd(stopCondition: (entry: any) => boolean): any[] {
    const all = this.read();
    const result: any[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      if (stopCondition(all[i])) break;
      result.unshift(all[i]);
    }
    return result;
  }

  clear(): void {
    writeFileSync(this.filePath, '');
  }
}
