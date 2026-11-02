export function parseArgv(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  return { command: command ?? "", args };
}
