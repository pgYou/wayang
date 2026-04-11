export interface IPersistenceHelper {
  readonly mode: 'save' | 'append';
  write(data: unknown): void;
  read(): unknown;
  readFromEnd?(stopCondition: (entry: any) => boolean): any[];
  clear(): void;
}
