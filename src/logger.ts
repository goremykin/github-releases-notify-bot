import fs from 'fs';

export class Logger {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  error(...args: unknown[]): void {
    console.log(...args);
    this.output(args, 'error');
  }

  log(...args: unknown[]): void {
    console.log(...args);
    this.output(args, 'info');
  }

  private output(items: unknown[], type: string): void {
    const str = `${(new Date).toISOString()} | ${type} | ${items.map((item) => String(item)).join(' ')}\n`;
    fs.writeFileSync(this.path, str, { flag: 'a+' });
  }
}
