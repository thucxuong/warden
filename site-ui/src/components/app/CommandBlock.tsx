import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** Shell commands get a `$` prompt; chat lines (`/warden:upgrade`, `reject FX-1: why`) do not. */
const SHELL = /^(warden|claude|bun|git|npm|npx) /;

/** Exact text to type, with a copy button. The page never runs it. */
export function CommandBlock({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the text is still selectable
    }
  };
  return (
    <div
      data-testid="command-block"
      className={cn("group flex items-center gap-2 rounded-md border bg-code py-1.5 pr-1.5 pl-3 font-mono text-[12.5px] text-code-foreground", className)}
    >
      <code className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {SHELL.test(command) && <span className="mr-2 select-none text-muted-foreground" aria-hidden>$</span>}
        {command}
      </code>
      <button
        type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy: ${command}`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
