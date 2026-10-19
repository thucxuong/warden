// Vendored from Kibo UI kanban (https://www.kibo-ui.com/r/kanban.json, 2026-10-19). Local edits: drag removed (view-only board); KanbanBoard passes extra div props (data-testid).
"use client";

import type { DndContextProps } from "@dnd-kit/core";
import { closestCenter, DndContext, useDroppable, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createContext, type HTMLAttributes, type ReactNode, useContext } from "react";
import { Card } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type KanbanItemProps = {
  id: string;
  name: string;
  column: string;
} & Record<string, unknown>;

type KanbanColumnProps = {
  id: string;
  name: string;
} & Record<string, unknown>;

type KanbanContextProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = {
  columns: C[];
  data: T[];
};

const KanbanContext = createContext<KanbanContextProps>({
  columns: [],
  data: [],
});

export type KanbanBoardProps = {
  id: string;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "id" | "children" | "className">;

export const KanbanBoard = ({ id, children, className, ...props }: KanbanBoardProps) => {
  const { setNodeRef } = useDroppable({ id, disabled: true });

  return (
    <div
      className={cn(
        "flex size-full min-h-40 flex-col divide-y overflow-hidden rounded-md border bg-secondary text-xs shadow-sm",
        className
      )}
      ref={setNodeRef}
      {...props}
    >
      {children}
    </div>
  );
};

export type KanbanCardProps<T extends KanbanItemProps = KanbanItemProps> = T & {
  children?: ReactNode;
  className?: string;
};

export const KanbanCard = <T extends KanbanItemProps = KanbanItemProps>({
  id,
  name,
  children,
  className,
}: KanbanCardProps<T>) => {
  const { setNodeRef, transition, transform } = useSortable({ id, disabled: true });

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  };

  return (
    <div style={style} ref={setNodeRef}>
      <Card className={cn("cursor-default gap-4 rounded-md p-3 shadow-sm", className)}>
        {children ?? <p className="m-0 font-medium text-sm">{name}</p>}
      </Card>
    </div>
  );
};

export type KanbanCardsProps<T extends KanbanItemProps = KanbanItemProps> =
  Omit<HTMLAttributes<HTMLDivElement>, "children" | "id"> & {
    children: (item: T) => ReactNode;
    id: string;
  };

export const KanbanCards = <T extends KanbanItemProps = KanbanItemProps>({
  children,
  className,
  ...props
}: KanbanCardsProps<T>) => {
  const { data } = useContext(KanbanContext) as KanbanContextProps<T>;
  const filteredData = data.filter((item) => item.column === props.id);
  const items = filteredData.map((item) => item.id);

  return (
    <ScrollArea className="overflow-hidden">
      <SortableContext items={items} disabled>
        <div className={cn("flex flex-grow flex-col gap-2 p-2", className)} {...props}>
          {filteredData.map(children)}
        </div>
      </SortableContext>
      <ScrollBar orientation="vertical" />
    </ScrollArea>
  );
};

export type KanbanHeaderProps = HTMLAttributes<HTMLDivElement>;

export const KanbanHeader = ({ className, ...props }: KanbanHeaderProps) => (
  <div className={cn("m-0 p-2 font-semibold text-sm", className)} {...props} />
);

export type KanbanProviderProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = Omit<DndContextProps, "children" | "sensors" | "onDragStart" | "onDragOver" | "onDragEnd"> & {
  children: (column: C) => ReactNode;
  className?: string;
  columns: C[];
  data: T[];
};

export const KanbanProvider = <
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
>({
  children,
  className,
  columns,
  data,
  ...props
}: KanbanProviderProps<T, C>) => {
  const sensors = useSensors();

  return (
    <KanbanContext.Provider value={{ columns, data }}>
      <DndContext collisionDetection={closestCenter} sensors={sensors} {...props}>
        <div className={cn("grid size-full auto-cols-fr grid-flow-col gap-4", className)}>
          {columns.map((column) => children(column))}
        </div>
      </DndContext>
    </KanbanContext.Provider>
  );
};
