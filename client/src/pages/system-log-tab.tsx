import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ScrollText, GitBranch, History, ChevronDown, ChevronUp, Package } from "lucide-react";
import { useStrategy } from "@/lib/strategy-context";

// ─── Types ───

interface LogEntry {
  id: number;
  timestamp: string;
  category: string;
  action: string;
  details: string | null;
}

interface ChangelogEntry {
  id: number;
  version: string;
  date: string;
  scope: string;
  title: string;
  changes: string[];
}

// ─── Helpers ───

function categoryBadgeClass(cat: string): string {
  switch (cat) {
    case "system": return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
    case "backtest": return "text-blue-400 border-blue-500/20 bg-blue-500/10";
    case "trade": return "text-[#22c55e] border-green-500/20 bg-green-500/10";
    case "kite": return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
    case "changelog": return "text-purple-400 border-purple-500/20 bg-purple-500/10";
    default: return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
  }
}

function scopeBadgeClass(scope: string): string {
  switch (scope) {
    case "system": return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
    case "atr_dip_buyer": return "text-orange-400 border-orange-500/20 bg-orange-500/10";
    case "bollinger_bounce": return "text-purple-400 border-purple-500/20 bg-purple-500/10";
    default: return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
  }
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "system": return "System";
    case "atr_dip_buyer": return "ATR Dip";
    case "bollinger_bounce": return "Bollinger";
    default: return scope;
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
  const { strategyId } = useStrategy();
  const [activeSection, setActiveSection] = useState<"changelog" | "activity">("changelog");
  const [changelogFilter, setChangelogFilter] = useState<string>("all");
  const [expandedVersions, setExpandedVersions] = useState<Set<number>>(new Set());

  const { data: logs, isLoading: logsLoading } = useQuery<LogEntry[]>({
    queryKey: ["/api/system/logs"],
    staleTime: 30000,
  });

  const { data: changelog, isLoading: changelogLoading } = useQuery<ChangelogEntry[]>({
    queryKey: ["/api/changelog"],
    staleTime: 60000,
  });

  const toggleVersion = (id: number) => {
    setExpandedVersions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Group changelog by version
  const filteredChangelog = (changelog ?? []).filter(entry => {
    if (changelogFilter === "all") return true;
    return entry.scope === changelogFilter || entry.scope === "system";
  });

  // Group entries by version+date for a nicer timeline view
  const versionGroups: Map<string, ChangelogEntry[]> = new Map();
  for (const entry of filteredChangelog) {
    const key = `${entry.version}`;
    if (!versionGroups.has(key)) versionGroups.set(key, []);
    versionGroups.get(key)!.push(entry);
  }

  return (
    <div className="space-y-4" data-testid="system-log-tab">
      {/* Section Toggle */}
      <div className="flex items-center gap-2" data-testid="section-toggle">
        <Button
          variant={activeSection === "changelog" ? "default" : "outline"}
          size="sm" className="h-8 text-xs gap-1.5"
          onClick={() => setActiveSection("changelog")}
          data-testid="button-changelog"
        >
          <GitBranch className="w-3.5 h-3.5" />
          Changelog
        </Button>
        <Button
          variant={activeSection === "activity" ? "default" : "outline"}
          size="sm" className="h-8 text-xs gap-1.5"
          onClick={() => setActiveSection("activity")}
          data-testid="button-activity"
        >
          <History className="w-3.5 h-3.5" />
          Activity Log
        </Button>
      </div>

      {/* ── Changelog Section ── */}
      {activeSection === "changelog" && (
        <Card data-testid="changelog-card">
          <CardHeader className="py-3 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-primary" />
                Software Changelog
              </CardTitle>
              <Select value={changelogFilter} onValueChange={setChangelogFilter}>
                <SelectTrigger className="h-7 text-[11px] w-[150px]" data-testid="select-changelog-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All Changes</SelectItem>
                  <SelectItem value="system" className="text-xs">System Only</SelectItem>
                  <SelectItem value="atr_dip_buyer" className="text-xs">ATR Dip Buyer</SelectItem>
                  <SelectItem value="bollinger_bounce" className="text-xs">Bollinger Bounce</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {changelogLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-5 w-48 bg-muted animate-pulse rounded" />
                    <div className="h-4 w-full bg-muted animate-pulse rounded" />
                    <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
                  </div>
                ))}
              </div>
            ) : !changelog || changelog.length === 0 ? (
              <div className="p-8 text-center">
                <GitBranch className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No changelog entries yet.</p>
              </div>
            ) : (
              <div className="space-y-1" data-testid="changelog-list">
                {Array.from(versionGroups.entries()).map(([version, entries]) => {
                  const date = entries[0].date;
                  const isExpanded = entries.some(e => expandedVersions.has(e.id));
                  const allEntries = entries;
                  
                  return (
                    <div key={version} className="border border-border rounded-lg overflow-hidden" data-testid={`changelog-version-${version}`}>
                      {/* Version header */}
                      <button
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left"
                        onClick={() => allEntries.forEach(e => toggleVersion(e.id))}
                        data-testid={`toggle-version-${version}`}
                      >
                        <Package className="w-4 h-4 text-primary shrink-0" />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-sm font-semibold tabular-nums">v{version}</span>
                          <span className="text-[11px] text-muted-foreground tabular-nums">{date}</span>
                          <div className="flex gap-1 ml-1">
                            {allEntries.map(e => (
                              <Badge key={e.id} variant="outline" className={`text-[9px] ${scopeBadgeClass(e.scope)}`}>
                                {scopeLabel(e.scope)}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <span className="text-[11px] text-muted-foreground mr-1">
                          {allEntries.reduce((s, e) => s + e.changes.length, 0)} changes
                        </span>
                        {isExpanded
                          ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        }
                      </button>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="px-4 pb-3 pt-0 border-t border-border bg-muted/10">
                          {allEntries.map(entry => (
                            <div key={entry.id} className="mt-3 first:mt-2">
                              <div className="flex items-center gap-2 mb-1.5">
                                <Badge variant="outline" className={`text-[9px] ${scopeBadgeClass(entry.scope)}`}>
                                  {scopeLabel(entry.scope)}
                                </Badge>
                                <span className="text-xs font-semibold">{entry.title}</span>
                              </div>
                              <ul className="space-y-0.5 ml-1">
                                {entry.changes.map((change, ci) => (
                                  <li key={ci} className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                                    <span className="text-primary mt-1 shrink-0">•</span>
                                    <span>{change}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Activity Log Section ── */}
      {activeSection === "activity" && (
        <Card data-testid="activity-log-card">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-primary" />
              Activity Log
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {logsLoading ? (
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
      )}
    </div>
  );
}
