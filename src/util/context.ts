/** The submission a piece of async work belongs to, so shared clients (Jev) can attribute their usage. */
import { AsyncLocalStorage } from "node:async_hooks";

export const submissionScope = new AsyncLocalStorage<string>();
