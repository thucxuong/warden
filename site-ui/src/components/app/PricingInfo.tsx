import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A small info icon beside a cost. Hover or focus shows which prices the cost uses. */
export function PricingInfo({ text, testId }: { text: string; testId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" data-testid={testId} aria-label="About this cost" className="ml-1 inline-flex cursor-help align-middle text-muted-foreground hover:text-foreground dark:text-white dark:hover:text-white">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}
