import type { BoardColumn, TicketCard } from "@api";
import { KanbanBoard, KanbanCard, KanbanCards, KanbanHeader, KanbanProvider } from "@/components/ui/kibo-ui/kanban";
import { TicketCardView } from "./TicketCardView";

const DOT: Record<string, string> = {
  backlog: "bg-muted-foreground/50", todo: "bg-primary", "in-progress": "bg-info", done: "bg-success", archived: "bg-muted-foreground/30",
};

/** The Kibo board with drag removed: cards move only when the ticket or run changes. */
export function TicketBoard({ columns, tickets, epicTitles }: { columns: BoardColumn[]; tickets: TicketCard[]; epicTitles: Map<string, string | null> }) {
  const cols = columns.map((c) => ({ id: c.id, name: c.title }));
  const items = tickets.map((t) => ({ id: t.id, name: t.title, column: t.column, card: t }));
  return (
    <div className="-mx-5 overflow-x-auto px-5 pb-2">
      <KanbanProvider columns={cols} data={items} className="min-w-[1180px] auto-cols-[minmax(232px,1fr)] items-start gap-3">
        {(col) => {
          const count = items.filter((i) => i.column === col.id).length;
          return (
            <KanbanBoard key={col.id} id={col.id} data-testid="board-column" data-column={col.id} className="max-h-[calc(100vh-14rem)] min-h-56 rounded-xl bg-muted/50 shadow-none">
              <KanbanHeader className="flex items-center gap-2 px-3 py-2.5">
                <span className={`size-2 rounded-full ${DOT[col.id] ?? "bg-muted-foreground"}`} />
                <span>{col.name}</span>
                <span data-testid="column-count" className="ml-auto rounded-full bg-background px-1.5 font-mono text-[11px] font-normal text-muted-foreground">{count}</span>
              </KanbanHeader>
              <KanbanCards id={col.id} className="gap-2 p-2">
                {(item: (typeof items)[number]) => (
                  <KanbanCard key={item.id} id={item.id} name={item.name} column={item.column} className="gap-0 rounded-lg p-3 shadow-xs transition-colors hover:border-primary/40">
                    <TicketCardView card={item.card} epicTitle={item.card.epic ? epicTitles.get(item.card.epic) : null} />
                  </KanbanCard>
                )}
              </KanbanCards>
              {count === 0 && <p className="px-3 pb-4 text-center text-xs text-muted-foreground">No tickets</p>}
            </KanbanBoard>
          );
        }}
      </KanbanProvider>
    </div>
  );
}
