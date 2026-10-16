/**
 * Spike M0(a), live part: Jev answer shapes and the practical state-size limit (ported from the Python
 * spikes/jev_probe.py). Needs TYPESAFE_API_KEY. Run `npm run jev:probe` and copy the output into docs/spikes.md.
 */
import { APIError, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { loadSettings } from "../src/settings";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("Set TYPESAFE_API_KEY to run the live Jev probe.");
  process.exit(1);
}
const SNIPPET = "client = ArmorIQClient.from_config('armoriq.yaml')\nclient.invoke(mcp_name='m', action='a')";
/** Statuses that mean "this state is too big", as opposed to an outage or auth failure. */
const TOO_BIG = new Set([400, 413, 422]);
const { jevModel: model } = loadSettings();
const client = new TypeSafeClient({ defaultModel: model });

const { data, requestId } = await client
  .systemOne({
    model,
    state: { snippet: SNIPPET },
    questions: {
      called: noul("Does `snippet` call the ArmorIQ SDK?"),
      depth: score("How deeply does `snippet` use the ArmorIQ SDK?", [
        "Not at all",
        "Mentions it",
        "Calls it once",
        "Full plan -> token -> invoke flow",
      ]),
    },
  })
  .withResponse();
console.log("request_id:", requestId, "| model:", data.model, "| usage:", JSON.stringify(data.usage));
console.log("noul:", JSON.stringify(data.answers.called));
console.log("score:", JSON.stringify(data.answers.depth));
const probs = Object.values(data.answers.depth.probabilities as Record<string, number>);
console.log("score probabilities sum:", probs.reduce((s, p) => s + p, 0).toFixed(4));

for (const words of [2_000, 8_000, 32_000, 128_000]) {
  try {
    await client.systemOne({
      model,
      state: { text: "word ".repeat(words) },
      questions: { q: noul("Is it long?") },
    });
    console.log(`state of ${words} words: accepted`);
  } catch (e) {
    if (!(e instanceof APIError && TOO_BIG.has(e.status))) throw e;
    console.log(`state of ${words} words: REJECTED (${e.status}) -> ${e.message}`);
    break;
  }
}
