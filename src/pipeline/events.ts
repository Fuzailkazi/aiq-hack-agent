/** Builds workflow node events: state changes, a route to follow, and/or an output. */
import { createEvent, type Event } from "@google/adk";

export function nodeEvent(opts: {
  state?: Record<string, unknown>;
  route?: string;
  output?: unknown;
}): Event {
  return createEvent({ output: opts.output, route: opts.route, actions: { stateDelta: opts.state ?? {} } });
}
