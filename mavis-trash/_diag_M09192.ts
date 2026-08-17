// One-off diagnostic: verify the M09192 fix.
import { routeQuestion } from "../src/lib/router";

const cases = [
  "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
  "M09192",
  "M09192 ticketjei",
  "Y-tengely előtoló motor csere szükséges",
  "M09112 leggyakoribb hiba a tengely csapágynál",
];

for (const q of cases) {
  const plan = routeQuestion(q, "hu");
  console.log("---");
  console.log("Q:", q);
  console.log("intent:", plan.intent);
  console.log("filters:", JSON.stringify(plan.filters));
}
