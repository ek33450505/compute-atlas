import { SuggestCorrection, type CorrectionField } from "@/components/contribute/suggest-correction";
import { firstCorrectableField, type MissingRecordItem } from "@/lib/facility-gaps";
import { cn } from "@/lib/utils";

/**
 * The one on-screen gap prompt of a facility page. It replaces the "Know a
 * source for …?" invites that used to repeat down the page; `items` comes from
 * `missingRecordItems` (lib/facility-gaps.ts), which names every section the
 * print summary names (a test pins that). Renders nothing for a complete record.
 *
 * The action opens the correction dialog on the first missing field it can
 * pre-select, else on "Something else" with that item as the topic.
 */
export function MissingRecordCard({
  facilityId,
  facilityName,
  items,
}: {
  facilityId: string;
  facilityName: string;
  items: MissingRecordItem[];
}) {
  if (items.length === 0) return null;

  const field = firstCorrectableField(items);
  const target: { defaultField: CorrectionField; topic?: string } = field
    ? { defaultField: field }
    : { defaultField: "other", topic: items[0].label };
  const headingId = `missing-record-${facilityId}`;

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border border-border bg-card p-5 text-card-foreground print:hidden"
    >
      <h2 id={headingId} className="font-display text-xl text-foreground">
        What this record is missing
      </h2>
      <p className="text-sm text-muted-foreground">No public source yet for:</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((item) => (
          <li key={item.label}>{item.label}</li>
        ))}
      </ul>
      <SuggestCorrection
        facilityId={facilityId}
        facilityName={facilityName}
        {...target}
        intent="add"
        showIntro={false}
        triggerLabel="Send a source"
        triggerAriaLabel={`Send a source for ${facilityName}`}
        triggerClassName={cn(
          "inline-flex min-h-11 items-center rounded-md border border-border bg-background px-4 text-sm font-medium",
          "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        )}
      />
    </section>
  );
}
