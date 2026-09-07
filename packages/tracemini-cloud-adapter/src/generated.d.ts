declare module '*build/tracemini/installer.mjs' {
  export function linuxInstallCommand(origin: string, token: string): string;
  export function linuxInstaller(cliDir: string, origin: string, token: string): string;
}
