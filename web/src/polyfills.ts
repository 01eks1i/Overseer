// Must be imported before any Solana library: they expect Node's Buffer to exist globally.
import { Buffer } from "buffer";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
