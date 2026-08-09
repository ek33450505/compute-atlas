#!/usr/bin/env node
// One-shot data-correction script (session s89): canonicalize the `operator`
// field in data/facilities.json per the Tier 1 map in the canonicalization
// spec. Any information carried by a dropped parenthetical/slash qualifier
// is preserved by appending a sentence to that record's `notes` (skipped if
// the fact is already stated there). Tier 2/3 values are intentionally left
// untouched — see spec for rationale.
//
// Usage: node scripts/canonicalize-operators.mjs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, "..", "data", "facilities.json");

// Exact from -> to map. Deliberately explicit (no regex stripping) so Tier 2
// (unresolved) and Tier 3 (qualifier-is-the-only-content, or genuine
// multi-party) values are never touched.
const RENAME_MAP = {
  Aligned: "Aligned Data Centers",
  "Eagle Rock Partners, LLC": "Eagle Rock Partners",
  "Galaxy Digital Holdings": "Galaxy Digital",
  Lumen: "Lumen Technologies",
  QTS: "QTS Data Centers",
  "QTS (Blackstone)": "QTS Data Centers",
  "QTS Data Centers (Blackstone)": "QTS Data Centers",
  "TierPoint, LLC": "TierPoint",
  Vantage: "Vantage Data Centers",
  "Vantage Data Centers (for OpenAI / Oracle)": "Vantage Data Centers",
  NTT: "NTT Global Data Centers",
  "NTT Global Data Centers Americas": "NTT Global Data Centers",
  "NTT (RagingWire)": "NTT Global Data Centers",
  "Bitdeer Technologies Group": "Bitdeer",
  "Bitdeer (development partner: Geis Development)": "Bitdeer",
  "Bitdeer (via subsidiary Whitetail Creek LLC)": "Bitdeer",
  "Cipher Mining": "Cipher Digital",
  "Cipher Digital (formerly Cipher Mining)": "Cipher Digital",
  "Crusoe Energy Systems": "Crusoe",
  "Crusoe Energy (Lancium Clean Campus)": "Crusoe",
  "Crusoe (with Blue Energy)": "Crusoe",
  "Amazon Web Services (developer: Panattoni Development Co.)":
    "Amazon Web Services",
  "Amazon Web Services (via Birchwood Power Partners)":
    "Amazon Web Services",
  "Amazon Web Services (with REB Investment Company, LLC as landowner)":
    "Amazon Web Services",
  "Google (with Intersect Power)": "Google",
  "Google (Montauk Innovations LLC)": "Google",
  "Google (via Willowbend Capital LLC)": "Google",
  "Google (with AES)": "Google",
  "Google (via Panattoni Development Co.)": "Google",
  "Meta (Greater Kudu LLC)": "Meta",
  "Meta (via shell J5 LLC)": "Meta",
  "CoreSite (American Tower)": "CoreSite",
  "CyrusOne (in exclusive negotiations with the US Army)": "CyrusOne",
  "Vistra (Luminant)": "Vistra",
  "Metrobloks (Lincoln Property Company)": "Metrobloks",
  "Core Scientific (CoreWeave is anchor customer)": "Core Scientific",
  "Core Scientific (site owner); CoreWeave Dalton II, LLC (sublessee/operator)":
    "Core Scientific",
  "Beale Infrastructure (AWS confirmed end-customer)": "Beale Infrastructure",
  "Beale Infrastructure (end-user unnamed)": "Beale Infrastructure",
  "Tract (MNLCO Farmington LLC / MNLCO Farmington Two LLC)": "Tract",
  "PowerHouse Data Centers (American Real Estate Partners / AREP, joint venture with Harrison Street)":
    "PowerHouse Data Centers",
  "PowerHouse Data Centers (AREP)": "PowerHouse Data Centers",
  "PowerHouse Data Centers / Chirisa (Blue Owl JV)": "PowerHouse Data Centers",
  "PowerHouse Data Centers (JV with Chirisa Technology Parks and Blue Owl Real Estate)":
    "PowerHouse Data Centers",
  "PowerHouse Data Centers / Pennsylvania Data Center Partners":
    "PowerHouse Data Centers",
  "PowerHouse Data Centers / Provident": "PowerHouse Data Centers",
  "Pacifico Energy (data center tenant unidentified)": "Pacifico Energy",
  "Raeden (proposed tenant; developer Majestic Realty)": "Raeden",
  "EdgeConneX (PowerConneX)": "EdgeConneX",
  "Homer City Redevelopment / Kiewit": "Homer City Redevelopment",
  "TeraWulf / Cayuga Operating Company": "TeraWulf",
  "Sentinel Data Centers / JGT2 Redevelopment": "Sentinel Data Centers",
};

// Per-source-operator-string note to append (only when the fact isn't
// already present in that record's notes). Bare renames / legal-suffix /
// brand-simplification drops with no informative qualifier are omitted —
// there is nothing to preserve.
const NOTE_APPEND = {
  "QTS (Blackstone)": "QTS Data Centers is owned by Blackstone (2021 take-private).",
  "QTS Data Centers (Blackstone)":
    "QTS Data Centers is owned by Blackstone (2021 take-private).",
  "NTT (RagingWire)":
    "Previously operated under NTT's legacy US brand, RagingWire (now retired).",
  "Bitdeer (development partner: Geis Development)":
    "Development partner: Geis Development.",
  "Bitdeer (via subsidiary Whitetail Creek LLC)":
    "Operated via subsidiary Whitetail Creek LLC.",
  "Cipher Mining": "Cipher Mining was renamed Cipher Digital.",
  "Cipher Digital (formerly Cipher Mining)":
    "Cipher Mining was renamed Cipher Digital.",
  "Crusoe Energy (Lancium Clean Campus)":
    "Also known as the Lancium Clean Campus.",
  "Crusoe (with Blue Energy)": "Partner: Blue Energy.",
  "Amazon Web Services (developer: Panattoni Development Co.)":
    "Developer: Panattoni Development Co.",
  "Amazon Web Services (via Birchwood Power Partners)":
    "Via Birchwood Power Partners.",
  "Amazon Web Services (with REB Investment Company, LLC as landowner)":
    "Landowner: REB Investment Company, LLC.",
  "Google (with Intersect Power)": "Partner: Intersect Power.",
  "Google (Montauk Innovations LLC)": "Operating entity: Montauk Innovations LLC.",
  "Google (via Willowbend Capital LLC)": "Via Willowbend Capital LLC.",
  "Google (with AES)": "Partner: AES.",
  "Google (via Panattoni Development Co.)": "Developer: Panattoni Development Co.",
  "Meta (Greater Kudu LLC)": "Operating entity: Greater Kudu LLC.",
  "Meta (via shell J5 LLC)": "Via shell entity J5 LLC.",
  "CoreSite (American Tower)": "Owned by American Tower.",
  "CyrusOne (in exclusive negotiations with the US Army)":
    "In exclusive negotiations with the US Army as of the cited source.",
  "Vistra (Luminant)": "Operates under subsidiary brand Luminant.",
  "Metrobloks (Lincoln Property Company)": "Partner: Lincoln Property Company.",
  "Core Scientific (CoreWeave is anchor customer)":
    "CoreWeave is the anchor customer.",
  "Core Scientific (site owner); CoreWeave Dalton II, LLC (sublessee/operator)":
    "Core Scientific is site owner; CoreWeave Dalton II, LLC is sublessee/operator.",
  "Beale Infrastructure (AWS confirmed end-customer)":
    "AWS confirmed as end-customer.",
  "Beale Infrastructure (end-user unnamed)": "End-user unnamed.",
  "Tract (MNLCO Farmington LLC / MNLCO Farmington Two LLC)":
    "Operating entities: MNLCO Farmington LLC / MNLCO Farmington Two LLC.",
  "PowerHouse Data Centers (American Real Estate Partners / AREP, joint venture with Harrison Street)":
    "Joint venture: American Real Estate Partners (AREP) and Harrison Street.",
  "PowerHouse Data Centers (AREP)":
    "Partner: American Real Estate Partners (AREP).",
  "PowerHouse Data Centers / Chirisa (Blue Owl JV)":
    "Joint venture with Chirisa Technology Parks and Blue Owl Real Estate.",
  "PowerHouse Data Centers (JV with Chirisa Technology Parks and Blue Owl Real Estate)":
    "Joint venture with Chirisa Technology Parks and Blue Owl Real Estate.",
  "PowerHouse Data Centers / Pennsylvania Data Center Partners":
    "Partner: Pennsylvania Data Center Partners.",
  "PowerHouse Data Centers / Provident": "Partner: Provident.",
  "Pacifico Energy (data center tenant unidentified)":
    "Data center tenant unidentified.",
  "Raeden (proposed tenant; developer Majestic Realty)":
    "Proposed tenant; developer: Majestic Realty.",
  "EdgeConneX (PowerConneX)": "Operates under power arm PowerConneX.",
  "Homer City Redevelopment / Kiewit": "EPC contractor: Kiewit.",
  "TeraWulf / Cayuga Operating Company":
    "Operating entity: Cayuga Operating Company (acquired plant).",
  "Sentinel Data Centers / JGT2 Redevelopment":
    "Site redeveloper: JGT2 Redevelopment.",
};

function noteAlreadyStates(existingNotes, fact) {
  if (!existingNotes) return false;
  // Cheap containment check on the distinguishing token(s) of the fact
  // (rather than the whole sentence, since phrasing may already differ).
  const distinguishing = fact
    .replace(/^(Partner|Developer|Landowner|Operating entity|Site redeveloper|EPC contractor):\s*/, "")
    .replace(/\.$/, "");
  return existingNotes.toLowerCase().includes(distinguishing.toLowerCase());
}

const raw = readFileSync(dataPath, "utf-8");
const facilities = JSON.parse(raw);

const beforeDistinct = new Set(facilities.map((f) => f.operator)).size;

const appended = [];
let renamedCount = 0;

for (const record of facilities) {
  const from = record.operator;
  const to = RENAME_MAP[from];
  if (!to) continue;

  const fact = NOTE_APPEND[from];
  if (fact && !noteAlreadyStates(record.notes, fact)) {
    const existing = record.notes ? record.notes.trim() : "";
    record.notes = existing
      ? `${existing.replace(/\.?\s*$/, ".")} ${fact}`
      : fact;
    appended.push({ id: record.id, from, appended: fact });
  }

  record.operator = to;
  renamedCount++;
}

facilities.sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(dataPath, JSON.stringify(facilities, null, 2) + "\n", "utf-8");

const afterDistinct = new Set(facilities.map((f) => f.operator)).size;
const survivors = [...new Set(facilities.map((f) => f.operator))]
  .filter((op) => op.includes("(") || op.includes(" / "))
  .sort();

console.log(`Records renamed: ${renamedCount}`);
console.log(`Distinct operators: ${beforeDistinct} -> ${afterDistinct}`);
console.log(`\nSurvivors still containing '(' or ' / ' (${survivors.length}):`);
for (const s of survivors) console.log(`  ${s}`);
console.log(`\nNotes appended (${appended.length}):`);
for (const a of appended) {
  console.log(`  [${a.id}] (was "${a.from}") -> appended: "${a.appended}"`);
}
