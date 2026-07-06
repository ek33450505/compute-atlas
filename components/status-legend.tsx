import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function StatusLegend() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle id="status-legend-title" className="text-base font-semibold">
          Build status
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul
          role="list"
          aria-labelledby="status-legend-title"
          className="space-y-3"
        >
          {STATUS_ORDER.map((status) => {
            const meta = STATUS_META[status];
            const Icon = meta.icon;
            return (
              <li key={status} className="flex items-start gap-3">
                <Icon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0"
                  style={{ color: getStatusColor(status) }}
                />
                <div className="min-w-0">
                  <span className="block text-sm font-medium leading-none">
                    {meta.label}
                  </span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {meta.description}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
