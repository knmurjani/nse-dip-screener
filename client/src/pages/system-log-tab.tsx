import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollText } from "lucide-react";

// ─── Types ───

interface LogEntry {
  id: number;
  timestamp: string;
  category: string;
  action: string;
  details: string | null;
}

// ─── Helpers ───

function categoryBadgeClass(cat: string): string {
  switch (cat) {
    case "system": return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
    case "backtest": return "text-blue-400 border-blue-500/20 bg-blue-500/10";
    case "trade": return "text-[#22c55e] border-green-500/20 bg-green-500/10";
    case "kite": return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
    default: return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true,
  });
}

// ─── Main Component ───

export default function SystemLogTab() {
  const { data: logs, isLoading } = useQuery<LogEntry[]>({
    queryKey: ["/api/system/logs"],
    staleTime: 30000,
  });

  return (
    <div className="space-y-4" data-testid="system-log-tab">
      <Card>
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-primary" />
            System Log
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="flex gap-4">
                  <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-40 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-48 bg-muted animate-pulse rounded" />
                </div>
              ))}
            </div>
          ) : !logs || logs.length === 0 ? (
            <div className="p-8 text-center">
              <ScrollText className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No log entries yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-[11px] pl-4">Timestamp (IST)</TableHead>
                    <TableHead className="text-[11px]">Category</TableHead>
                    <TableHead className="text-[11px]">Action</TableHead>
                    <TableHead className="text-[11px] pr-4">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log, i) => (
                    <TableRow key={log.id} data-testid={`row-log-${i}`}>
                      <TableCell className="text-xs tabular-nums text-muted-foreground py-2 pl-4 whitespace-nowrap">
                        {formatTimestamp(log.timestamp)}
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] capitalize ${categoryBadgeClass(log.category)}`}
                          data-testid={`log-category-${i}`}
                        >
                          {log.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs py-2 font-medium">
                        {log.action}
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground py-2 pr-4 max-w-[400px] truncate">
                        {log.details || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
