import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RefreshButton() {
  const qc = useQueryClient();
  const busy = useIsFetching() > 0;
  return (
    <Button
      variant="outline" size="sm" aria-label="Refresh" title="Refresh (data loads on demand)"
      onClick={() => void qc.refetchQueries({ type: "active" }, { cancelRefetch: false })}  // a click joins a running fetch instead of restarting it
      className="h-8 gap-1.5"
    >
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
      <span className="hidden sm:inline">Refresh</span>
    </Button>
  );
}
