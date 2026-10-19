import { Route, Switch } from "wouter";
import { AppShell } from "@/components/app/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocsPage } from "@/pages/DocsPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { HomePage } from "@/pages/HomePage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { RunPage } from "@/pages/RunPage";
import { TicketsPage } from "@/pages/TicketsPage";

export function App() {
  return (
    <TooltipProvider delayDuration={150}>
      <AppShell>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/runs/:task">{(p) => <RunPage key={p.task} task={decodeURIComponent(p.task)} />}</Route>
          <Route path="/tickets" component={TicketsPage} />
          <Route path="/history" component={HistoryPage} />
          <Route path="/docs" component={DocsPage} />
          <Route component={NotFoundPage} />
        </Switch>
      </AppShell>
    </TooltipProvider>
  );
}
