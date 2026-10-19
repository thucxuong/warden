import { SearchX } from "lucide-react";
import { Link } from "wouter";
import { EmptyState } from "@/components/app/States";

export function NotFoundPage() {
  return (
    <div className="mx-auto mt-10 max-w-lg" data-testid="not-found">
      <EmptyState text="This page does not exist." icon={SearchX} className="bg-card py-12">
        <Link href="/" className="text-sm text-primary hover:underline">Back to the overview</Link>
      </EmptyState>
    </div>
  );
}
