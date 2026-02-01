declare module 'qrcode-terminal' {
  export function generate(
    text: string,
    options?: { small?: boolean },
    callback?: (qrText: string) => void
  ): void
  export function setErrorLevel(level: string): void
}
