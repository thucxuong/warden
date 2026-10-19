import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost" size="icon" className="size-8" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      data-testid="theme-toggle" onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}
