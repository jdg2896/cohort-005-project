import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "~/components/ui/card";

/**
 * The card each Student-facing section below a lesson's video sits in, so
 * Notes and Questions & Discussion share one header and one rhythm.
 */
export function LessonSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="mb-8 gap-0 p-6">
      <div className="mb-4 flex items-start gap-2">
        <Icon className="mt-1 size-5 shrink-0 text-primary" />
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </Card>
  );
}
