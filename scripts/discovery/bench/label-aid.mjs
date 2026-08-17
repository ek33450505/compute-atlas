// Labeling aid. Does NOT decide anything -- it surfaces the evidence a human must
// read. s96 wrote 3 of 14 labels from assumption and every error blamed a model
// for being right; s97 then found the DB's value often comes from a DIFFERENT
// source than the page under test (apple-maiden-nc's page never mentions Maiden).
// So: the DB value is a HINT, never a label.
import { readFileSync } from "node:fs";
const P = JSON.parse(readFileSync(new URL("./pages.json", import.meta.url).pathname, "utf8"));
const only = process.argv[2];

const FIELDS = {
  capacity: { re: /(\d[\d.,]*)\s*(MW\b|megawatt|GW\b|gigawatt)/gi, hint: (t) => `plan=${t.capacityMwPlanned} oper=${t.capacityMwOperational}` },
  onsite:   { re: /(on-?site|behind-the-meter|self-generat|turbine|generation facility|power plant)/gi, hint: (t) => `onSite=${t.onSiteGenerationMw}` },
  utility:  { re: /\b(utility|electric co-?op|cooperative|power company|Energy|Electric|PUD|Duke|AEP|PPL|Con Ed|Xcel|Dominion|Georgia Power|NV Energy|Rocky Mountain)\b/gi, hint: (t) => `util=${t.energyUtility}` },
  source:   { re: /\b(grid|nuclear|natural gas|on-?site gas|solar|wind|hydro|hydroelectric|geothermal|coal|renewable)\b/gi, hint: (t) => `src=${t.energySource}` },
};

for (const p of P) {
  if (only && p.facilityId !== only) continue;
  console.log(`\n${"=".repeat(100)}`);
  console.log(`${p.facilityId}  [${p.facilityType}/${p.status}]  ${p.name} — ${p.city}, ${p.state}`);
  console.log(`  ${p.extractMode} ${p.text.length}ch (raw ${p.rawLength})  ${p.url.slice(0, 88)}`);
  console.log(`  DB HINT: plan=${p.truth.capacityMwPlanned} oper=${p.truth.capacityMwOperational} src=${p.truth.energySource} util=${p.truth.energyUtility} onsite=${p.truth.onSiteGenerationMw}`);
  for (const [fname, f] of Object.entries(FIELDS)) {
    const hits = [...p.text.matchAll(f.re)];
    if (!hits.length) { console.log(`  -- ${fname}: NO TOKEN (pre-filter would skip -> label null)`); continue; }
    if (fname === "capacity") {
      console.log(`  -- capacity: ${hits.length} figure(s)`);
      for (const m of hits.slice(0, 10)) {
        const s = Math.max(0, m.index - 190), e = Math.min(p.text.length, m.index + 130);
        console.log(`       [${m[0]}]  …${p.text.slice(s, e).replace(/\s+/g, " ")}…`);
      }
    } else {
      const uniq = [...new Set(hits.map((m) => m[0].toLowerCase()))].slice(0, 12);
      console.log(`  -- ${fname}: ${uniq.join(", ")}`);
    }
  }
}
