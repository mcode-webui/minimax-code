export interface DesignFileWriteOptions {
  platform?: NodeJS.Platform;
  wait?(delayMs: number): Promise<void>;
  move?(from: string, to: string): Promise<void>;
}

/** Replace one file with another, retrying the transient refusal Windows hands out. */
export function replaceFile(from: string, to: string, options?: DesignFileWriteOptions): Promise<void>;

/** Write a file atomically: the bytes go to a temporary file that is renamed over the target. */
export function writeFileAtomically(file: string, text: string | Uint8Array, options?: DesignFileWriteOptions): Promise<void>;
